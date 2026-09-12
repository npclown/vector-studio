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
    | Readonly<{ kind: 'container'; children: readonly string[] }>
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
