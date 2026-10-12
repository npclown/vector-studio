import type {
  CameraApplyResult,
  FillMeshPort,
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
import { PathMeshPipeline, type PathMeshStatistics } from './path-mesh-pipeline.js';
import { PrimitiveSceneSource } from './primitive-scene-source.js';
import { RetainedSceneMirror } from './scene-mirror.js';

export type PrimitiveRendererServiceOptions = Readonly<{
  fillMesh?: FillMeshPort;
  /** Host-supplied accounting hook, for example a V2 adapter's linearMemoryBytes. Not part of the port. */
  fillMeshMemoryBytes?: () => number;
}>;

/** Owns the CPU scene mirror and packet source while the backend owns scheduling and native state. */
export class PrimitiveRendererService
  implements RendererSceneSynchronization, PrimitiveFrameSource
{
  readonly #invalidationTarget: RendererInvalidationTarget;
  readonly #mirror: RetainedSceneMirror;
  readonly #source: PrimitiveSceneSource;
  #disposed = false;
  /** P3 V3 section f: true exactly when a fill-mesh port is given; read by the backend at attach. */
  public readonly requiresMeshPipeline: boolean;

  public constructor(
    invalidationTarget: RendererInvalidationTarget,
    options: PrimitiveRendererServiceOptions = {},
  ) {
    const port = options.fillMesh;
    const memoryBytes = options.fillMeshMemoryBytes;
    if (port !== undefined) assertFillMeshPort(port);
    if (memoryBytes !== undefined && typeof memoryBytes !== 'function') {
      throw new TypeError('fillMeshMemoryBytes must be a function.');
    }
    this.#invalidationTarget = invalidationTarget;
    this.requiresMeshPipeline = port !== undefined;
    // P3 V3 section a: path nodes are supported exactly when a port is given.
    this.#mirror = new RetainedSceneMirror(undefined, {
      pathNodes: port === undefined ? 'unsupported' : 'supported',
    });
    this.#source = new PrimitiveSceneSource(
      this.#mirror,
      port === undefined
        ? undefined
        : new PathMeshPipeline(memoryBytes === undefined ? { port } : { port, memoryBytes }),
    );
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

  public getPreparationStatistics(): ReturnType<PrimitiveSceneSource['getPreparationStatistics']> {
    return this.#source.getPreparationStatistics();
  }

  /** CPU attributions of the path-mesh cache; null without a port. */
  public getPathMeshStatistics(): PathMeshStatistics | null {
    return this.#source.getPathMeshStatistics();
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

/** A malformed port is a host programming error, not scene input (P3 V3 section a). */
function assertFillMeshPort(port: FillMeshPort): void {
  const candidate = port as unknown as Record<string, unknown> | null;
  if (
    typeof candidate !== 'object' ||
    candidate === null ||
    candidate.portVersion !== 0 ||
    typeof candidate.operationId !== 'string' ||
    candidate.operationId.length === 0 ||
    typeof candidate.buildFillMeshes !== 'function'
  ) {
    throw new TypeError('fillMesh must be a FillMeshPort with portVersion 0.');
  }
}
