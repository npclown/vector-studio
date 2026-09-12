import type {
  CameraApplyResult,
  RenderCamera,
  RenderCameraState,
  RenderChangeSet,
  RendererInvalidationTarget,
  RendererSceneSynchronization,
  RenderSceneSnapshot,
  SceneApplyResult,
  SceneSynchronizationState,
} from '@vector-studio/contracts';

import type {
  PrimitiveFrameSource,
  PrimitivePacket,
  PrimitiveReceipt,
  PrimitiveTarget,
} from './primitive-packet.js';
import { PrimitiveSceneSource } from './primitive-scene-source.js';
import { RetainedSceneMirror } from './scene-mirror.js';

/** Owns the CPU scene mirror and packet source while the backend owns scheduling and native state. */
export class PrimitiveRendererService
  implements RendererSceneSynchronization, PrimitiveFrameSource
{
  readonly #invalidationTarget: RendererInvalidationTarget;
  readonly #mirror: RetainedSceneMirror;
  readonly #source: PrimitiveSceneSource;
  #disposed = false;

  public constructor(invalidationTarget: RendererInvalidationTarget) {
    this.#invalidationTarget = invalidationTarget;
    this.#mirror = new RetainedSceneMirror();
    this.#source = new PrimitiveSceneSource(this.#mirror);
  }

  public replaceSnapshot(snapshot: RenderSceneSnapshot): SceneApplyResult {
    const result = this.#mirror.replaceSnapshot(snapshot);
    if (result.status === 'applied') this.#invalidate('scene');
    return result;
  }

  public applyChanges(changes: RenderChangeSet): SceneApplyResult {
    const result = this.#mirror.applyChanges(changes);
    if (result.status === 'applied') this.#invalidate('scene');
    return result;
  }

  public getSynchronizationState(): SceneSynchronizationState {
    return this.#mirror.getSynchronizationState();
  }

  public setCamera(camera: RenderCamera): CameraApplyResult {
    const result = this.#mirror.setCamera(camera);
    if (result.status === 'applied') this.#invalidate('viewport');
    return result;
  }

  public getCameraState(): RenderCameraState | null {
    return this.#mirror.getCameraState();
  }

  public prepare(target: PrimitiveTarget): PrimitivePacket | null {
    return this.#source.prepare(target);
  }

  public acknowledge(receipt: PrimitiveReceipt): void {
    this.#source.acknowledge(receipt);
  }

  public dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#source.dispose();
    this.#mirror.dispose();
  }

  #invalidate(reason: 'scene' | 'viewport'): void {
    try {
      this.#invalidationTarget.invalidate({ reason });
    } catch {
      // CPU publication is authoritative even if an injected target rejects invalidation.
    }
  }
}
