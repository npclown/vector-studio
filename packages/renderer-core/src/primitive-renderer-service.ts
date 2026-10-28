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
  StrokeMeshPort,
} from '@vector-studio/contracts';

import type {
  PrimitiveFrameSource,
  PrimitivePacket,
  PrimitiveReceipt,
  PrimitiveTarget,
} from './primitive-packet.js';
import { buildPathFringe } from './path-fringe.js';
import {
  PathMeshPipeline,
  type PathDrawRecordForTesting,
  type PathMeshStatistics,
} from './path-mesh-pipeline.js';
import { PrimitiveSceneSource } from './primitive-scene-source.js';
import { RetainedSceneMirror } from './scene-mirror.js';

export type PrimitiveRendererServiceOptions = Readonly<{
  fillMesh?: FillMeshPort;
  /** Host-supplied accounting hook, for example a V2 adapter's linearMemoryBytes. Not part of the port. */
  fillMeshMemoryBytes?: () => number;
  /** B2 stroke contract, section 9.1. A stroke port without a fill port is allowed. */
  strokeMesh?: StrokeMeshPort;
  /** Host-supplied accounting hook for the stroke port's linear memory. Not part of the port. */
  strokeMeshMemoryBytes?: () => number;
  /**
   * @internal Tests only (E10 contract, section 3.1): 'off' draws every path paint region-only
   * (c = 1, no exterior triangles) and never calls the fringe builder. Default 'on'.
   */
  fringeForTesting?: 'on' | 'off';
  /**
   * P4 contract, U3 and U4: 'rect' draws rect clips through the clip pipeline variants, which
   * the backend then creates, and reports a mask container as `unsupported-feature`; 'all'
   * also draws mask containers through mask textures. Default 'none': every non-null clip is
   * reported as `unsupported-feature`, and nothing else changes.
   */
  clips?: 'none' | 'rect' | 'all';
}>;

/** Owns the CPU scene mirror and packet source while the backend owns scheduling and native state. */
export class PrimitiveRendererService
  implements RendererSceneSynchronization, PrimitiveFrameSource
{
  readonly #invalidationTarget: RendererInvalidationTarget;
  readonly #mirror: RetainedSceneMirror;
  readonly #source: PrimitiveSceneSource;
  #disposed = false;
  /**
   * P3 V3 section f: true exactly when a fill-mesh or a stroke-mesh port is given; read by the
   * backend at attach.
   */
  public readonly requiresMeshPipeline: boolean;
  /** P4 contract, U3: true exactly when the `clips` option draws clips; read at attach. */
  public readonly requiresClipPipeline: boolean;

  public constructor(
    invalidationTarget: RendererInvalidationTarget,
    options: PrimitiveRendererServiceOptions = {},
  ) {
    const port = options.fillMesh;
    const memoryBytes = options.fillMeshMemoryBytes;
    const strokePort = options.strokeMesh;
    const strokeMemoryBytes = options.strokeMeshMemoryBytes;
    if (port !== undefined) assertFillMeshPort(port);
    if (memoryBytes !== undefined && typeof memoryBytes !== 'function') {
      throw new TypeError('fillMeshMemoryBytes must be a function.');
    }
    if (strokePort !== undefined) assertStrokeMeshPort(strokePort);
    if (strokeMemoryBytes !== undefined && typeof strokeMemoryBytes !== 'function') {
      throw new TypeError('strokeMeshMemoryBytes must be a function.');
    }
    const fringe = options.fringeForTesting ?? 'on';
    if (fringe !== 'on' && fringe !== 'off') {
      throw new TypeError("fringeForTesting must be 'on' or 'off'.");
    }
    const clips = options.clips ?? 'none';
    if (clips !== 'none' && clips !== 'rect' && clips !== 'all') {
      throw new TypeError("clips must be 'none', 'rect' or 'all'.");
    }
    this.#invalidationTarget = invalidationTarget;
    this.requiresClipPipeline = clips !== 'none';
    const anyPort = port !== undefined || strokePort !== undefined;
    this.requiresMeshPipeline = anyPort;
    // P3 V3 section a with the B2 section 9.1 amendment (S4): path nodes are supported when a
    // fill port, a stroke port or both are given; fills exactly when a fill port is given, and
    // strokes with width > 0 exactly when a stroke port is given.
    this.#mirror = new RetainedSceneMirror(undefined, {
      pathNodes: anyPort ? 'supported' : 'unsupported',
      pathFills: port === undefined ? 'unsupported' : 'supported',
      pathStrokes: strokePort === undefined ? 'unsupported' : 'supported',
      clips: clips === 'all' ? 'supported' : clips === 'rect' ? 'rect' : 'unsupported',
    });
    this.#source = new PrimitiveSceneSource(
      this.#mirror,
      !anyPort
        ? undefined
        : new PathMeshPipeline({
            ...(port === undefined ? {} : { port }),
            ...(memoryBytes === undefined ? {} : { memoryBytes }),
            ...(strokePort === undefined ? {} : { strokePort }),
            ...(strokeMemoryBytes === undefined ? {} : { strokeMemoryBytes }),
            // P3 V3 section e: the exact fringe builder, a D8-interim placement (V3-Q3 c); the
            // stroke mesh uses it unchanged (B2 section 9.5). E10: no builder when 'off'.
            ...(fringe === 'on' ? { fringeBuilder: buildPathFringe } : {}),
          }),
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

  /**
   * @internal Tests only (ST-U7 addendum, ST-A15 and ST-A17): overlay builds of the path-mesh
   * pipeline so far, 0 without a port. It is not part of PathMeshStatistics.
   */
  public getOverlayBuildCountForTesting(): number {
    return this.#source.getOverlayBuildCountForTesting();
  }

  /**
   * @internal Tests only (P4 contract, P4-A06): clip-state records written so far, counting a
   * record only when its index slot changed content against the previous frame.
   */
  public getClipStateWritesForTesting(): number {
    return this.#source.getClipStateWrites();
  }

  /**
   * @internal Tests only (E10 contract, section 3.1): the draw record of the last non-null
   * prepare; null before the first one and without a port.
   */
  public getLastDrawRecordForTesting(): PathDrawRecordForTesting | null {
    return this.#source.getLastDrawRecordForTesting();
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
  if (!hasPortShape(port, 'buildFillMeshes')) {
    throw new TypeError('fillMesh must be a FillMeshPort with portVersion 0.');
  }
}

/** V3's port shape check applied to the stroke port (B2 stroke contract, section 9.1). */
function assertStrokeMeshPort(port: StrokeMeshPort): void {
  if (!hasPortShape(port, 'buildStrokeMeshes')) {
    throw new TypeError('strokeMesh must be a StrokeMeshPort with portVersion 0.');
  }
}

function hasPortShape(port: unknown, method: string): boolean {
  const candidate = port as Record<string, unknown> | null;
  return (
    typeof candidate === 'object' &&
    candidate !== null &&
    candidate.portVersion === 0 &&
    typeof candidate.operationId === 'string' &&
    candidate.operationId.length > 0 &&
    typeof candidate[method] === 'function'
  );
}
