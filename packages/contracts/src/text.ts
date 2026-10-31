// Glyph raster port of the E28 contract (docs/plans/d9-e28-text-glyph-atlas-contract.md,
// section 2). Plain data only, as for the mesh ports: requests and results carry plain values
// and typed buffers, never a canvas, font or DOM object.

export type GlyphRasterPhase = 0 | 0.25 | 0.5 | 0.75;

export interface GlyphRasterRequest {
  /** One grapheme cluster (E28-S2). */
  readonly text: string;
  readonly fontList: string;
  readonly lang: string;
  /** The size bucket, in device px (E28-K2). */
  readonly pixelSize: number;
  /** The pen origin's offset inside its first pixel (E28-K3). */
  readonly phaseX: GlyphRasterPhase;
}

export type GlyphRasterResult =
  | Readonly<{
      status: 'ok';
      width: number;
      height: number;
      /**
       * Whole numbers: the pen point, before the phase, is the corner between bitmap pixels
       * `left - 1` and `left` horizontally and `top - 1` and `top` vertically.
       */
      left: number;
      top: number;
      /** Row-major coverage, `width * height` bytes. */
      coverage: Uint8Array;
    }>
  | Readonly<{ status: 'empty' }>
  | Readonly<{ status: 'failed'; reason: 'too-large' | 'unavailable' }>;

export interface GlyphRasterPort {
  readonly portVersion: 0;
  /** Names the implementation, for example 'canvas-2d/raster-v1'. */
  readonly operationId: string;
  /** Synchronous; a throw is caught by the renderer and reported (E28-D3). */
  rasterize(request: GlyphRasterRequest): GlyphRasterResult;
}

// Text layout port of the M6a contract (docs/plans/mvp-m6a-text-model-contract.md, section 3).
// Plain data only, as the raster port above: strings and numbers, no DOM, FontFace or element
// type, so `contracts` compiles without the DOM library (M6a-A04). The editor builds requests
// from text nodes and is the only caller that does (M6-L1); the renderer holds no layout port and
// sees layouts only through the `text` scene nodes the editor projects (M6a section 3.1).
//
// Measurement scale (M6a section 3.2, M6-Q3 (a)): requests and results are in page units, the
// node-local units of the node's frame, with no camera or device pixel ratio applied. If the
// M6a-A12 DPR or size-linearity checks fail, the implementation switches to a fixed reference
// scale internally (requests multiplied, results divided); this interface does not change.

/** One style run of a text node, without its colour (layout does not depend on it). */
export type TextLayoutRun = Readonly<{
  text: string;
  /** One family name (M6a-S3), never a CSS list; the port builds the font list. */
  family: string;
  /** Page units, in (0, SCENE_TEXT_MAX_SIZE]. */
  size: number;
}>;

export type TextLayoutAlign = 'left' | 'center' | 'right';

export type TextLayoutRequest = Readonly<{
  /** Canonical, as stored (M6a-S1 to S4); the node text is their concatenation, in UTF-16. */
  runs: readonly TextLayoutRun[];
  /** `null`: no wrapping (`autoWidth`); otherwise the wrapping width in page units. */
  width: number | null;
  align: TextLayoutAlign;
  /** Em of each run's size. */
  letterSpacing: number;
  /** Multiple of each run's size (CSS unitless). */
  lineHeight: number;
}>;

/**
 * M6a-L1: one line. Offsets are UTF-16 into the node text; lines tile the text and `end` excludes
 * the line's LF. `top`, `height` and `baseline` are node-local y. `width` is `max(0, e)`, `e` the
 * pen extent of the content without hanging spaces (the pen position after the line's last
 * non-space cluster), so it is never negative under negative letter spacing. `left` is the aligned
 * start, `max(0, (W - width) * k)` with `W` the result width and `k` 0, 0.5 or 1 by `align`, so a
 * line wider than the box starts at 0. An empty line has `width` 0 and `left` at its alignment
 * point.
 */
export type TextLayoutLine = Readonly<{
  start: number;
  end: number;
  top: number;
  height: number;
  baseline: number;
  left: number;
  width: number;
}>;

/**
 * M6a-L1: one grapheme cluster (LF excluded), in text order. Run boundaries are also cluster
 * boundaries. `x` and `y` are the baseline pen origin with alignment applied (`y` equals the
 * line's `baseline`); `advance` includes letter spacing. Both `x` and `advance` may be negative
 * under negative letter spacing. A grapheme longer than
 * SCENE_TEXT_MAX_CLUSTER_UNITS is cut into pieces of at most that many units without splitting a
 * surrogate pair: the first piece has the grapheme's `x` and whole `advance`, later pieces the
 * same `x` and `advance` 0.
 */
export type TextLayoutCluster = Readonly<{
  start: number;
  end: number;
  /** Index into `lines`. */
  line: number;
  /** Index into the request's `runs`. */
  run: number;
  x: number;
  y: number;
  advance: number;
}>;

/**
 * M6a-L1 coordinates: node-local page units, origin at the box's top-left, y down. M6c fills one
 * E28 `text` scene node from one result (M6a section 3.1): `generation` and `lang` per node,
 * `fontLists[run]` as each scene run's `fontList`, the run's model colour unchanged as its
 * straight-alpha `color` (text stays solid colour), one scene run per maximal sequence of
 * clusters with the same `run` on one line.
 */
export type TextLayoutResult = Readonly<{
  /** The port generation this result was computed at (M6a-L3). */
  generation: number;
  /**
   * BCP 47, the port's configuration, one per result and per scene node, never stored
   * (M6a-Q1): 1 to SCENE_TEXT_MAX_LANG ASCII letters, digits and '-' (E28-S1).
   */
  lang: string;
  /**
   * The request width, or for `width: null` the widest line width; never negative, since line
   * widths are not.
   */
  width: number;
  /** The sum of line heights. */
  height: number;
  /**
   * Per run index, the CSS font-family list the measurement used (M6-F2), at most
   * SCENE_TEXT_MAX_FONT_LIST characters.
   */
  fontLists: readonly string[];
  lines: readonly TextLayoutLine[];
  clusters: readonly TextLayoutCluster[];
}>;

export interface TextLayoutPort {
  /** M6a-L4: 0 until a breaking change; `createEditor` rejects any other version. */
  readonly portVersion: 0;
  /**
   * M6a-L3: a non-negative safe integer that never decreases, so a larger value is newer. Each
   * event that may change layouts (a font settles or loads, a registry change, a device pixel
   * ratio change) increases it.
   */
  readonly generation: number;
  /**
   * M6a-L2: synchronous, never throws for a request built from a valid node, and deep-equal
   * results for deep-equal requests at one generation.
   */
  layout(request: TextLayoutRequest): TextLayoutResult;
  /**
   * Listeners run synchronously after each generation increase, in registration order, and may
   * call `layout`. As in `EventTarget` dispatch, a listener unsubscribed during a dispatch is not
   * called later in it, and one subscribed during it first runs on the next increase. Returns the
   * unsubscribe function.
   */
  subscribe(listener: () => void): () => void;
}
