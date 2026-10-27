export type SceneAffine = readonly [number, number, number, number, number, number];
export type ScenePoint = Readonly<{ x: number; y: number }>;
export type SceneColor = Readonly<{ r: number; g: number; b: number; a: number }>;
export type SceneIdentity = Readonly<{ documentId: string; pageId: string }>;
export type SceneVersion = Readonly<{ identity: SceneIdentity; revision: number }>;
export type RenderCamera = Readonly<{ position: ScenePoint; zoom: number }>;
export type RenderCameraState = Readonly<{ camera: RenderCamera; revision: number }>;
export type CameraApplyResult =
  | Readonly<{ status: 'applied' | 'unchanged'; current: RenderCameraState }>
  | Readonly<{ status: 'invalid-camera'; reason: 'invalid-value' | 'revision-overflow' }>
  | Readonly<{ status: 'disposed' }>;
export type SceneStroke = Readonly<{ color: SceneColor; width: number }>;
export type PrimitiveStyle = Readonly<{
  fill: SceneColor | null;
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
/** A path stroke (P3 B2 stroke contract, section 5). Primitive strokes keep SceneStroke. */
export type PathStroke = Readonly<{
  color: SceneColor;
  /** Node-local units, finite, >= 0. */
  width: number;
  cap: SceneStrokeCap;
  join: SceneStrokeJoin;
  /** Finite, >= 1, required for every join kind. */
  miterLimit: number;
}>;
/** `stroke` is required and explicitly null when absent. */
export type PathStyle = Readonly<{ fill: SceneColor | null; stroke: PathStroke | null }>;
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
