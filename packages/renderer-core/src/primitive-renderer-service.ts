import type {
  CameraApplyResult,
  FillMeshPort,
  GlyphRasterPort,
  ImageSourcePort,
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
  /**
   * E23 contract, U3: 'gradient' accepts gradient paints (E23-S3) and draws them through the
   * paint pipeline variants, which the backend then creates. Default 'solid': a gradient paint
   * is reported as `unsupported-feature`, and nothing else changes. V-32 (V32-S3): 'image' also
   * accepts image fill paints, drawn from `imageSource`.
   */
  paints?: 'solid' | 'gradient' | 'image';
  /** V-32 contract (V32-P1): the image source port; required by `paints: 'image'`. */
  imageSource?: ImageSourcePort;
  /**
   * E25 contract, E25-S1: 'isolated' accepts container opacity other than 1 and draws each
   * visible container with 0 < opacity < 1 as an isolated layer, through the layer pipeline,
   * which the backend then creates. It needs `clips` other than 'none'. Default 'flat': such a
   * container is reported as `unsupported-feature`, and nothing else changes.
   */
  groups?: 'flat' | 'isolated';
  /**
   * E41 contract, E41-S6: 'v0' accepts node effects (drop shadows, layer blur) and plans each
   * effect root as a layer with its effect bounds and budget (U4b). It needs `groups:
   * 'isolated'`. Until a backend draws the effect passes (U5), effect roots draw their content
   * without effects (section 5.3). Default 'none': a node with effects is reported as
   * `unsupported-feature`, and nothing else changes.
   */
  effects?: 'none' | 'v0';
  /**
   * @internal Tests only (E25-A05): with `groups: 'isolated'`, every visible container with
   * opacity 1 is drawn as a layer too, so its layer variants can be compared with the main pass.
   */
  isolateUnitOpacityForTesting?: boolean;
  /**
   * E28 contract, E28-S3: 'atlas' accepts text nodes and draws them from a glyph atlas filled by
   * `glyphRaster`, through the text pipeline, which the backend then creates. It needs `clips`
   * other than 'none' and a `glyphRaster` port. Default 'none': every text node is reported as
   * `unsupported-feature`, and nothing else changes.
   */
  text?: 'none' | 'atlas';
  /** E28 contract, section 2: the glyph raster port; required by `text: 'atlas'`. */
  glyphRaster?: GlyphRasterPort;
  /**
   * @internal Tests only (E28 contract, T8): the atlas page limit, 1 to 8, with `text: 'atlas'`.
   * Default 8.
   */
  textAtlasPagesForTesting?: number;
  /**
   * @internal Tests only (E28 contract, T8): the atlas page edge, 16 to 2048 px, with
   * `text: 'atlas'`. Default 2048; the backend reads it from the packet.
   */
  textAtlasPageSizeForTesting?: number;
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
  /** E23 contract, U3: true exactly when the `paints` option is 'gradient'; read at attach. */
  public readonly requiresPaintPipeline: boolean;
  /** E25 contract, U3: true exactly when the `groups` option is 'isolated'; read at attach. */
  public readonly requiresLayerPipeline: boolean;
  /** E28 contract, E28-S3: true exactly when the `text` option is 'atlas'; read at attach. */
  public readonly requiresTextPipeline: boolean;
  /** E41 contract, U5: true exactly when the `effects` option is 'v0'; read at attach. */
  public readonly requiresEffectPipeline: boolean;
  /** V-32 (V32-P1): the image source port under `paints: 'image'`; read at attach. */
  public readonly imageSource?: ImageSourcePort;
  #unsubscribeImages: (() => void) | null = null;

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
    const paints = options.paints ?? 'solid';
    if (paints !== 'solid' && paints !== 'gradient' && paints !== 'image') {
      throw new TypeError("paints must be 'solid', 'gradient' or 'image'.");
    }
    // V-32 (V32-P2): image paints need the image source port.
    const imageSource = options.imageSource;
    if (imageSource !== undefined) assertImageSourcePort(imageSource);
    if (paints === 'image' && imageSource === undefined) {
      throw new TypeError("paints: 'image' needs an imageSource port.");
    }
    const groups = options.groups ?? 'flat';
    if (groups !== 'flat' && groups !== 'isolated') {
      throw new TypeError("groups must be 'flat' or 'isolated'.");
    }
    // E25-Q2 (a): clips inside a layer apply per leaf, through the clip variants.
    if (groups === 'isolated' && clips === 'none') {
      throw new TypeError("groups: 'isolated' needs clips other than 'none'.");
    }
    const isolateUnit = options.isolateUnitOpacityForTesting ?? false;
    if (typeof isolateUnit !== 'boolean' || (isolateUnit && groups !== 'isolated')) {
      throw new TypeError("isolateUnitOpacityForTesting needs groups: 'isolated'.");
    }
    const effects = options.effects ?? 'none';
    if (effects !== 'none' && effects !== 'v0') {
      throw new TypeError("effects must be 'none' or 'v0'.");
    }
    if (effects === 'v0' && groups !== 'isolated') {
      throw new TypeError("effects: 'v0' needs groups: 'isolated'.");
    }
    const text = options.text ?? 'none';
    if (text !== 'none' && text !== 'atlas') {
      throw new TypeError("text must be 'none' or 'atlas'.");
    }
    const glyphRaster = options.glyphRaster;
    if (glyphRaster !== undefined) assertGlyphRasterPort(glyphRaster);
    if (text === 'atlas' && clips === 'none') {
      throw new TypeError("text: 'atlas' needs clips other than 'none'.");
    }
    if (text === 'atlas' && glyphRaster === undefined) {
      throw new TypeError("text: 'atlas' needs a glyphRaster port.");
    }
    const atlasPages = options.textAtlasPagesForTesting;
    if (
      atlasPages !== undefined &&
      (text !== 'atlas' || !Number.isSafeInteger(atlasPages) || atlasPages < 1 || atlasPages > 8)
    ) {
      throw new TypeError("textAtlasPagesForTesting must be 1 to 8, with text: 'atlas'.");
    }
    const atlasPageSize = options.textAtlasPageSizeForTesting;
    if (
      atlasPageSize !== undefined &&
      (text !== 'atlas' ||
        !Number.isSafeInteger(atlasPageSize) ||
        atlasPageSize < 16 ||
        atlasPageSize > 2048)
    ) {
      throw new TypeError("textAtlasPageSizeForTesting must be 16 to 2048, with text: 'atlas'.");
    }
    this.#invalidationTarget = invalidationTarget;
    this.requiresTextPipeline = text === 'atlas';
    this.requiresClipPipeline = clips !== 'none';
    this.requiresPaintPipeline = paints === 'gradient' || paints === 'image';
    if (paints === 'image') {
      this.imageSource = imageSource!;
      // V32-K3: a key that became ready or failed is drawn (or reported) on the next frame.
      this.#unsubscribeImages = imageSource!.subscribe(() => this.#invalidate('scene'));
    }
    this.requiresLayerPipeline = groups === 'isolated';
    this.requiresEffectPipeline = effects === 'v0';
    const anyPort = port !== undefined || strokePort !== undefined;
    this.requiresMeshPipeline = anyPort;
    // P3 V3 section a with the B2 section 9.1 amendment (S4): path nodes are supported when a
    // fill port, a stroke port or both are given; fills exactly when a fill port is given, and
    // strokes with width > 0 exactly when a stroke port is given. E24-S3: dashes with them, since
    // the pipeline expands a dash ahead of the stroke port.
    this.#mirror = new RetainedSceneMirror(undefined, {
      pathNodes: anyPort ? 'supported' : 'unsupported',
      pathFills: port === undefined ? 'unsupported' : 'supported',
      pathStrokes: strokePort === undefined ? 'unsupported' : 'supported',
      dashes: strokePort === undefined ? 'unsupported' : 'supported',
      clips: clips === 'all' ? 'supported' : clips === 'rect' ? 'rect' : 'unsupported',
      paints,
      groupOpacity: groups === 'isolated' ? 'supported' : 'unsupported',
      textNodes: text === 'atlas' ? 'supported' : 'unsupported',
      effects,
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
      {
        ...(isolateUnit ? { isolateUnitOpacityForTesting: true } : {}),
        // E28 section 4: the service holds the invalidation target, so a packet with deferred
        // clusters invalidates once when it is acknowledged.
        ...(text === 'atlas'
          ? {
              text: {
                port: glyphRaster!,
                ...(atlasPages === undefined ? {} : { pages: atlasPages }),
                ...(atlasPageSize === undefined ? {} : { pageSize: atlasPageSize }),
                onDeferred: () => this.#invalidate('scene'),
              },
            }
          : {}),
      },
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
   * @internal Tests only (E24-A04): dash expansions of the path-mesh pipeline so far, 0 without
   * a port. It is not part of PathMeshStatistics.
   */
  public getDashExpansionCountForTesting(): number {
    return this.#source.getDashExpansionCountForTesting();
  }

  /** @internal Tests only (E28 section 4, Counters): glyph raster port calls so far. */
  public getGlyphRasterCallsForTesting(): number {
    return this.#source.getGlyphRasterCallsForTesting();
  }

  /** @internal Tests only (E28 section 4, Counters): bitmaps written by acknowledged packets. */
  public getGlyphUploadsForTesting(): number {
    return this.#source.getGlyphUploadsForTesting();
  }

  /** @internal Tests only (E28 section 4, Counters): atlas pages evicted by acknowledged packets. */
  public getAtlasEvictionsForTesting(): number {
    return this.#source.getAtlasEvictionsForTesting();
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
    try {
      this.#unsubscribeImages?.();
    } catch {
      // A port's unsubscribe failure does not stop disposal.
    }
    this.#unsubscribeImages = null;
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

/** V32-P1: a malformed image port is a host programming error. */
function assertImageSourcePort(port: ImageSourcePort): void {
  if (
    typeof port !== 'object' ||
    port === null ||
    port.portVersion !== 0 ||
    typeof port.request !== 'function' ||
    typeof port.subscribe !== 'function'
  ) {
    throw new TypeError('imageSource must be an ImageSourcePort with portVersion 0.');
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

/** E28 contract, E28-S3: V3's port shape check applied to the glyph raster port. */
function assertGlyphRasterPort(port: GlyphRasterPort): void {
  if (!hasPortShape(port, 'rasterize')) {
    throw new TypeError('glyphRaster must be a GlyphRasterPort with portVersion 0.');
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
