import type {
  CameraApplyResult,
  RenderCamera,
  RenderCameraState,
  RenderChangeSet,
  RenderSceneSnapshot,
  RendererSceneSynchronization,
  SceneApplyResult,
  SceneSynchronizationState,
} from '@vector-studio/contracts';
import { RetainedSceneMirror, type RetainedSceneMirrorOptions } from '@vector-studio/renderer-core';

// P5-U4 recording test renderer (P5 plan, sections 4.5 and 7, P5-A09): the renderer-core
// scene mirror, which validates every snapshot and change set as the real renderer does,
// wrapped to record each call and its result.

export type RecordedCall =
  | Readonly<{ method: 'replaceSnapshot'; input: RenderSceneSnapshot; result: SceneApplyResult }>
  | Readonly<{ method: 'applyChanges'; input: RenderChangeSet; result: SceneApplyResult }>
  | Readonly<{ method: 'setCamera'; input: RenderCamera; result: CameraApplyResult }>;

export class RecordingRenderer implements RendererSceneSynchronization {
  readonly calls: RecordedCall[] = [];
  readonly mirror: RetainedSceneMirror;
  /** Replaces the next result of the named method once, for rejection tests. */
  readonly overrides: Partial<{
    replaceSnapshot: SceneApplyResult;
    applyChanges: SceneApplyResult;
    setCamera: CameraApplyResult;
  }> = {};

  /**
   * `paths` sets every path port; `options` overrides single ports (M1-U3: a renderer without a
   * fill port). Clips (P4) are drawn unless `options.clips` says otherwise.
   */
  constructor(
    paths: 'supported' | 'unsupported' = 'supported',
    options: Partial<RetainedSceneMirrorOptions> = {},
  ) {
    this.mirror = new RetainedSceneMirror(() => undefined, {
      pathNodes: paths,
      pathStrokes: paths,
      clips: 'supported',
      ...options,
    });
  }

  replaceSnapshot(snapshot: RenderSceneSnapshot): SceneApplyResult {
    const result = this.take('replaceSnapshot') ?? this.mirror.replaceSnapshot(snapshot);
    this.calls.push({ method: 'replaceSnapshot', input: snapshot, result });
    return result;
  }

  applyChanges(changes: RenderChangeSet): SceneApplyResult {
    const result = this.take('applyChanges') ?? this.mirror.applyChanges(changes);
    this.calls.push({ method: 'applyChanges', input: changes, result });
    return result;
  }

  setCamera(camera: RenderCamera): CameraApplyResult {
    const result = this.take('setCamera') ?? this.mirror.setCamera(camera);
    this.calls.push({ method: 'setCamera', input: camera, result });
    return result;
  }

  getSynchronizationState(): SceneSynchronizationState {
    return this.mirror.getSynchronizationState();
  }

  getCameraState(): RenderCameraState | null {
    return this.mirror.getCameraState();
  }

  dispose(): void {
    this.mirror.dispose();
  }

  private take<K extends keyof RecordingRenderer['overrides']>(key: K) {
    const value = this.overrides[key];
    delete this.overrides[key];
    return value as RecordingRenderer['overrides'][K] | undefined;
  }
}
