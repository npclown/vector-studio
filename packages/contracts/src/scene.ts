export type SceneAffine = readonly [number, number, number, number, number, number];
export type ScenePoint = Readonly<{ x: number; y: number }>;
export type SceneColor = Readonly<{ r: number; g: number; b: number; a: number }>;
/** E23 contract (docs/plans/d9-e23-gradient-paint-contract.md), section 2. */
export type SceneGradientSpread = 'pad' | 'reflect' | 'repeat';
export type SceneGradientStop = Readonly<{ offset: number; color: SceneColor }>;
/**
 * `transform` maps gradient space to the node's local space. Linear: t = x in gradient space.
 * Radial: t = |g|, so the unit circle is t = 1. Stops are interpolated premultiplied.
 */
export type SceneGradient = Readonly<{
  kind: 'linear' | 'radial';
  transform: SceneAffine;
  stops: readonly SceneGradientStop[];
  spread: SceneGradientSpread;
}>;
/** A solid colour or one gradient (E23-S1). */
export type ScenePaint = SceneColor | SceneGradient;
/** E23-S2: more stops is `unsupported-feature`. */
export const SCENE_MAX_GRADIENT_STOPS = 16;
/** E23-S1: a gradient paint carries `kind`; a solid colour does not. */
export function isSceneGradient(paint: ScenePaint): paint is SceneGradient {
  return 'kind' in paint;
}
export type SceneIdentity = Readonly<{ documentId: string; pageId: string }>;
export type SceneVersion = Readonly<{ identity: SceneIdentity; revision: number }>;
export type RenderCamera = Readonly<{ position: ScenePoint; zoom: number }>;
export type RenderCameraState = Readonly<{ camera: RenderCamera; revision: number }>;
export type CameraApplyResult =
  | Readonly<{ status: 'applied' | 'unchanged'; current: RenderCameraState }>
  | Readonly<{ status: 'invalid-camera'; reason: 'invalid-value' | 'revision-overflow' }>
  | Readonly<{ status: 'disposed' }>;
export type SceneStroke = Readonly<{ color: ScenePaint; width: number }>;
export type PrimitiveStyle = Readonly<{
  fill: ScenePaint | null;
  stroke: SceneStroke | null;
}>;
export type PrimitiveGeometry =
  | Readonly<{
      kind: 'rectangle';
      width: number;
      height: number;
      cornerRadii: readonly [number, number, number, number];
    }>
  | Readonly<{ kind: 'ellipse'; width: number; height: number }>
  | Readonly<{ kind: 'line'; start: ScenePoint; end: ScenePoint }>;
export type ScenePathVerb = 'move' | 'line' | 'cubic' | 'close';
export type SceneFillRule = 'nonzero' | 'evenodd';
export type ScenePathGeometry = Readonly<{
  kind: 'path';
  verbs: readonly ScenePathVerb[];
  /** Interleaved node-local x, y. move and line take one point, cubic three, close none. */
  points: readonly number[];
  fillRule: SceneFillRule;
}>;
export type SceneStrokeCap = 'butt' | 'round' | 'square';
export type SceneStrokeJoin = 'miter' | 'round' | 'bevel';
/**
 * E24 contract, section 2: a dash pattern and phase in node-local units, the units of the
 * stroke's width. Entries alternate on and off, starting on; an odd count is repeated once.
 */
export type SceneDash = Readonly<{ pattern: readonly number[]; phase: number }>;
/** E24-S1: more pattern entries than this is `unsupported-feature`. */
export const SCENE_MAX_DASH_ENTRIES = 16;
/** A path stroke (P3 B2 stroke contract, section 5). Primitive strokes keep SceneStroke. */
export type PathStroke = Readonly<{
  color: ScenePaint;
  /** Node-local units, finite, >= 0. */
  width: number;
  cap: SceneStrokeCap;
  join: SceneStrokeJoin;
  /** Finite, >= 1, required for every join kind. */
  miterLimit: number;
  /** E24 contract (E24-Q5 (a)): absent or null is a solid stroke. */
  dash?: SceneDash | null;
}>;
/** `stroke` is required and explicitly null when absent. */
export type PathStyle = Readonly<{ fill: ScenePaint | null; stroke: PathStroke | null }>;
/**
 * P4 contract (docs/plans/p4-clip-mask.md), section 2. `rect` clips the container's descendants
 * to a closed rectangle in its local space; `mask` uses `children[0]`'s fill area as the mask of
 * the other children and never paints it.
 */
export type SceneClip =
  | null
  | Readonly<{ kind: 'rect'; x: number; y: number; width: number; height: number }>
  | Readonly<{ kind: 'mask' }>;
/** P4 contract, section 2: the deepest supported clip depth of a node. */
export const SCENE_MAX_CLIP_DEPTH = 32;
/**
 * E25 contract (docs/plans/d9-e25-isolated-opacity-contract.md), E25-S2: the deepest supported
 * isolation depth of a node, the number of its visible proper ancestors with 0 < opacity < 1.
 */
export const SCENE_MAX_ISOLATION_DEPTH = 32;
/**
 * E28 contract (docs/plans/d9-e28-text-glyph-atlas-contract.md), E28-S1 and S2: one grapheme
 * cluster of a text run. `x` and `y` are the node-local pen origin on the baseline, with
 * alignment and letter spacing already applied by layout; `advance` is used for bounds only.
 */
export type SceneTextCluster = Readonly<{ text: string; x: number; y: number; advance: number }>;
/** E28-S1: a run of clusters in one font list, size and solid colour. */
export type SceneTextRun = Readonly<{
  /** The M6-F2 CSS font-family list, exactly as layout used it. */
  fontList: string;
  /** Node-local units, in (0, SCENE_TEXT_MAX_SIZE]. */
  size: number;
  color: SceneColor;
  clusters: readonly SceneTextCluster[];
}>;
/** E28-S2 limits. */
export const SCENE_TEXT_MAX_SIZE = 4096;
export const SCENE_TEXT_MAX_CLUSTERS = 16_384;
export const SCENE_TEXT_MAX_RUNS = 16_384;
export const SCENE_TEXT_MAX_CLUSTER_UNITS = 32;
export const SCENE_TEXT_MAX_FONT_LIST = 512;
export const SCENE_TEXT_MAX_LANG = 35;
export type SceneNodeBase = Readonly<{
  id: string;
  parentId: string | null;
  transform: SceneAffine;
  visible: boolean;
  opacity: number;
}>;
export type RenderNodeSnapshot = SceneNodeBase &
  (
    | Readonly<{ kind: 'primitive'; geometry: PrimitiveGeometry; style: PrimitiveStyle }>
    | Readonly<{ kind: 'path'; geometry: ScenePathGeometry; style: PathStyle }>
    | Readonly<{ kind: 'container'; children: readonly string[]; clip: SceneClip }>
    | Readonly<{
        kind: 'text';
        /** The layout port's generation (M6-F4), a non-negative safe integer. */
        generation: number;
        /** E28-S1: 1 to SCENE_TEXT_MAX_LANG ASCII letters, digits and '-'. */
        lang: string;
        runs: readonly SceneTextRun[];
      }>
  );
export type RenderSceneSnapshot = SceneVersion &
  Readonly<{ nodes: readonly RenderNodeSnapshot[]; rootOrder: readonly string[] }>;
export type RenderChildOrder = Readonly<{
  parentId: string | null;
  children: readonly string[];
}>;
export type RenderChangeSet = SceneVersion &
  Readonly<{
    baseRevision: number;
    inserted: readonly RenderNodeSnapshot[];
    updated: readonly RenderNodeSnapshot[];
    removed: readonly string[];
    orders: readonly RenderChildOrder[];
  }>;
export type SceneSynchronizationState = Readonly<{
  status: 'awaiting-snapshot' | 'synchronized' | 'resync-required' | 'disposed';
  current: SceneVersion | null;
}>;
export type SceneRejectionReason =
  | 'invalid-value'
  | 'duplicate-id'
  | 'unknown-node'
  | 'invalid-parent'
  | 'cycle'
  | 'invalid-order'
  | 'conflicting-operation'
  | 'unsupported-feature'
  | 'stale-snapshot'
  | 'revision-conflict';
export type SceneApplyResult =
  | Readonly<{ status: 'applied' | 'replayed'; current: SceneVersion }>
  | Readonly<{
      status: 'invalid-scene';
      reason: SceneRejectionReason;
      current: SceneVersion | null;
    }>
  | Readonly<{ status: 'resync-required'; current: SceneVersion | null }>
  | Readonly<{ status: 'disposed' }>;
export interface RendererSceneSynchronization {
  replaceSnapshot(snapshot: RenderSceneSnapshot): SceneApplyResult;
  applyChanges(changes: RenderChangeSet): SceneApplyResult;
  getSynchronizationState(): SceneSynchronizationState;
  setCamera(camera: RenderCamera): CameraApplyResult;
  getCameraState(): RenderCameraState | null;
  dispose(): void;
}
