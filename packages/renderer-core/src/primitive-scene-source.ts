import { isSceneGradient } from '@vector-studio/contracts';
import type { RenderNodeSnapshot, SceneAffine, SceneVersion } from '@vector-studio/contracts';
import type {
  ClipMaskPacketLevel,
  MeshFillDraw,
  MeshPacketPart,
  MeshResourceId,
  LayerPacketPart,
  PrimitiveDraw,
  PrimitiveFrameSource,
  PrimitivePacket,
  PrimitiveReceipt,
  PrimitiveRecordVersion,
  PrimitiveResource,
  PrimitiveResourceId,
  PrimitiveTarget,
  PrimitiveWrite,
} from './primitive-packet.js';
import {
  PRIMITIVE_STRIDES,
  PrimitiveNumericPreparationError,
  assessPrimitivePacking,
  normalizeRectangleRadii,
  writePackedRecord,
} from './primitive-packing.js';
import type {
  DerivedPath,
  PathDrawRecordEntryForTesting,
  PathDrawRecordForTesting,
  PathMeshDraw,
  PathMeshPipeline,
  PathMeshStatistics,
} from './path-mesh-pipeline.js';
import {
  PathMeshPacker,
  meshFrameLanes,
  selectMeshOrigin,
  type MeshOrigin,
} from './path-mesh-packet.js';
import { GradientRecordTable, paintColorLanes, type GradientPaintRecord } from './paint-records.js';
import type { RetainedSceneMirror, RetainedSceneView } from './scene-mirror.js';
import {
  ClipStateTable,
  MaskPlan,
  extendClipChain,
  meetsClipChain,
  type ClipChain,
  type ClipMaskLevel,
  type ClipStateRecord,
  type MaskBudgetNotice,
  type MaskSourceRecord,
} from './clip-resolution.js';
import {
  composeSceneAffine,
  getPathLocalPointBounds,
  getPathLocalStrokeBounds,
  getPrimitiveLocalStrokeBounds,
  transformSceneBounds,
  type SceneBounds,
} from './scene-numeric.js';
import {
  layerBound,
  planLayerBudget,
  type DeviceRect,
  type LayerResourceNotice,
  type LayerScope,
} from './layer-plan.js';

type InstanceResource = 'transforms' | 'geometry' | 'styles';
type PrimitivePreparationStatistics = Readonly<{
  geometryBuilds: number;
  recordWrites: Readonly<{
    transforms: number;
    geometry: number;
    styles: number;
    order: number;
    frame: number;
  }>;
}>;
type Origin = Readonly<{ x: number; y: number }>;
type DerivedPrimitive = Readonly<{
  id: string;
  slot: number;
  node: Extract<RenderNodeSnapshot, { kind: 'primitive' }>;
  world: SceneAffine;
  localBounds: SceneBounds;
  worldBounds: SceneBounds;
  hidden: boolean;
  omitted: boolean;
  /** P4 contract, U2: the clipping ancestors, or null when unclipped. */
  clip: ClipChain | null;
  /** Position in the authoritative depth-first order of primitive and path leaves. */
  sequence: number;
  /** E25 contract, U2: the innermost isolated container, or null outside layers. */
  layer: LayerScope | null;
}>;
type VersionedRecords = {
  transforms: Array<symbol | undefined>;
  geometry: Array<symbol | undefined>;
  styles: Array<symbol | undefined>;
  order: Array<symbol | undefined>;
  frame: Array<symbol | undefined>;
};
type PendingPacket = Readonly<{
  packet: PrimitivePacket;
  expected: ReadonlyMap<PrimitiveResourceId, ReadonlyMap<number, symbol>>;
  meshExpected: ReadonlyMap<MeshResourceId, ReadonlyMap<number, symbol>> | null;
}>;
type PackingKeys = Readonly<{
  transform: readonly number[];
  geometry: readonly number[];
  style: readonly number[];
}>;
type DerivedCacheEntry = Readonly<{
  transform: SceneAffine;
  parentWorldVersion: symbol;
  worldVersion: symbol;
  world: SceneAffine;
  hidden: boolean;
  localKey: readonly number[] | null;
  localBounds: SceneBounds | null;
  worldBounds: SceneBounds | null;
  omitted: boolean;
}>;

const RESOURCE_ORDER = ['transforms', 'geometry', 'styles', 'order', 'frame'] as const;
/** P4 contract, section 5: the queue limits of `render.clip-resource-limit`, as for path-mesh failures. */
const MASK_NOTICES_QUEUED = 4096;
const MASK_NOTICES_PER_PACKET = 32;
/** E25 contract, section 5: the queue limits of `render.layer-resource-limit`, as for masks. */
const LAYER_NOTICES_QUEUED = 4096;
const LAYER_NOTICES_PER_PACKET = 32;
const IDENTITY: SceneAffine = [1, 0, 0, 1, 0, 0];

export class PrimitiveSceneSource implements PrimitiveFrameSource {
  readonly #mirror: RetainedSceneMirror;
  #sceneEpoch: symbol | null = null;
  #slots = new Map<string, number>();
  #slotIds: Array<string | undefined> = [];
  #primitiveCapacity = 16;
  #orderCapacity = 16;
  #incarnations = createIncarnations();
  #buffers = createBuffers(16, 16);
  #versions: VersionedRecords = createVersions();
  #values: Record<InstanceResource, Array<readonly number[] | undefined>> = {
    transforms: [],
    geometry: [],
    styles: [],
  };
  #orderValues: number[] = [];
  #frameValues: readonly number[] | null = null;
  #origin: Origin | null = null;
  #originRevision = Symbol('primitive-origin');
  #activeGeneration: number | null = null;
  #reconstructedGeneration: number | null = null;
  #reconstructedEpoch: symbol | null = null;
  #reconstructedIncarnation: symbol | null = null;
  #pending: PendingPacket | null = null;
  #derivedCache = new Map<string, DerivedCacheEntry>();
  #packingKeys = new Map<string, PackingKeys>();
  #geometryBuilds = 0;
  #recordWrites: Record<PrimitiveResourceId, number> = {
    transforms: 0,
    geometry: 0,
    styles: 0,
    order: 0,
    frame: 0,
  };
  #disposed = false;
  readonly #pathMeshes: PathMeshPipeline | undefined;
  readonly #meshPacker = new PathMeshPacker();
  #meshOrigin: MeshOrigin | null = null;
  #meshOriginRevision = Symbol('mesh-origin');
  /** The generation whose first skipped mesh receipt stopped mesh draws and writes. */
  #meshStoppedGeneration: number | null = null;
  /** E10 contract, section 3.1: non-null prepares so far and the last one's draw record. */
  #prepareSerial = 0;
  #drawRecord: PathDrawRecordForTesting | null = null;
  /** P4 contract, U2: the frame's clip states and their change count. */
  readonly #clipStates = new ClipStateTable();
  #clipStatesUsed = false;
  /** E23 contract, U2: the frame's gradient records. */
  readonly #gradients = new GradientRecordTable();
  /**
   * P4 contract, section 5: budget notices are queued on a level's transition to over budget,
   * at most 4,096 queued and 32 per packet; overflow is counted.
   */
  #overBudget = new Set<string>();
  #maskNotices: MaskBudgetNotice[] = [];
  #maskNoticesDropped = 0;
  /** E25 contract, section 5: the layer budget's notices, queued as the mask notices are. */
  #layersOverBudget = new Set<string>();
  #layerNotices: LayerResourceNotice[] = [];
  #layerNoticesDropped = 0;
  /** @internal Tests only (E25-A05): every visible container with opacity 1 is a layer too. */
  readonly #isolateUnitOpacity: boolean;
  /** P3 V3 section f: true exactly when this source consumes a fill-mesh or stroke-mesh port. */
  public readonly requiresMeshPipeline: boolean;

  public constructor(
    mirror: RetainedSceneMirror,
    pathMeshes?: PathMeshPipeline,
    options: Readonly<{ isolateUnitOpacityForTesting?: boolean }> = {},
  ) {
    this.#isolateUnitOpacity = options.isolateUnitOpacityForTesting === true;
    this.#mirror = mirror;
    this.#pathMeshes = pathMeshes;
    this.requiresMeshPipeline = pathMeshes !== undefined;
  }

  public prepare(target: PrimitiveTarget): PrimitivePacket | null {
    if (this.#disposed) return null;
    validateTarget(target);
    const scene = this.#mirror.readRetainedScene();
    const cameraState = this.#mirror.getCameraState();
    if (scene === null || cameraState === null) return null;

    const epochChanged = scene.sceneEpoch !== this.#sceneEpoch;
    if (epochChanged) this.#resetForSnapshot(scene);
    else this.#reconcileSlots(scene);

    const paths: DerivedPath[] = [];
    const pathSequences = new Map<string, number>();
    const clipSeen = { value: false };
    const layerScopes: LayerScope[] = [];
    const pathLayers = new Map<string, LayerScope>();
    const derived = derivePrimitives(
      scene,
      this.#slots,
      this.#derivedCache,
      paths,
      pathSequences,
      clipSeen,
      layerScopes,
      pathLayers,
      this.#isolateUnitOpacity,
    );
    let visible = cullPrimitives(
      derived.filter((entry) => !entry.hidden && !entry.omitted && entry.clip?.empty !== true),
      cameraState.camera,
      target,
    );
    // P3 V3 section f: the per-view mesh origin O_m, separate from the primitive origin.
    let meshFrame: readonly number[] | null = null;
    if (this.#pathMeshes !== undefined) {
      const meshOrigin = selectMeshOrigin(
        cameraState.camera.position,
        cameraState.camera.zoom,
        target.devicePixelRatio,
        this.#meshOrigin,
      );
      if (meshOrigin !== null && meshOrigin !== this.#meshOrigin) {
        this.#meshOrigin = meshOrigin;
        this.#meshOriginRevision = Symbol('mesh-origin');
      }
      meshFrame = meshFrameLanes(
        meshOrigin,
        cameraState.camera.position,
        cameraState.camera.zoom,
        target,
      );
    }
    // P3 V3 section b: port results are published before any packing, so a later packing
    // error never repeats a port call.
    let pathDraws: readonly PathMeshDraw[] =
      this.#pathMeshes?.prepare({
        paths,
        geometryRevision: (id) => scene.getGeometryRevision(id),
        camera: cameraState.camera,
        target,
        packing: {
          origin: this.#meshOrigin ?? { x: 0, y: 0 },
          frameFinite: meshFrame !== null,
        },
      }) ?? [];
    // E25 contract, section 4: layer bounds and the layer budget come before the mask plan, so
    // content of a layer tree that is not drawn spends no mask budget.
    let layerPlan: DrawnLayers | null = null;
    if (layerScopes.length > 0) {
      layerPlan = this.#planLayers(
        layerScopes,
        visible,
        pathDraws,
        new Map(paths.map((path) => [path.id, path] as const)),
        pathLayers,
        cameraState.camera,
        target,
      );
      const drawn = layerPlan.indices;
      const inDrawn = (layer: LayerScope | null | undefined) =>
        layer === null || layer === undefined || drawn.has(layer);
      visible = visible.filter((primitive) => inDrawn(primitive.layer));
      pathDraws = pathDraws.filter(
        (draw) => draw.maskSource === true || inDrawn(pathLayers.get(draw.nodeId)),
      );
    } else if (this.#layersOverBudget.size > 0) {
      this.#layersOverBudget = new Set();
    }
    // P4 contract, U4: mask levels are planned over the drawn content in paint order; content
    // under an undrawable level (empty bound, a source covering nothing, over the budget) is
    // not drawn, and mask source draws never paint.
    let masks: MaskPlan | null = null;
    // U4: the primitive mask sources are packed and drawn by their slots, so they join the
    // visible primitives in the origin choice and the packing budget.
    let assessed = visible;
    const pathClips = new Map(paths.map((path) => [path.id, path.clip ?? null] as const));
    if (clipSeen.value) {
      masks = this.#planMasks(scene, derived, pathDraws, cameraState.camera, target);
      const plan = masks;
      const content = [
        ...visible.map((primitive) => ({ sequence: primitive.sequence, chain: primitive.clip })),
        ...pathDraws
          .filter((draw) => draw.maskSource !== true)
          .map((draw) => ({
            sequence: pathSequences.get(draw.nodeId)!,
            chain: pathClips.get(draw.nodeId) ?? null,
          })),
      ].sort((left, right) => left.sequence - right.sequence);
      for (const entry of content) plan.admit(entry.chain);
      visible = visible.filter((primitive) => plan.admit(primitive.clip));
      const used = new Set(
        plan.levels.flatMap((level) => (level.source.kind === 'mesh' ? [level.source.nodeId] : [])),
      );
      this.#queueMaskNotices(plan.notices);
      const sourceSlots = new Set(
        plan.levels.flatMap((level) =>
          level.source.kind === 'primitive' ? [level.source.slot] : [],
        ),
      );
      if (sourceSlots.size > 0) {
        assessed = [...visible, ...derived.filter((primitive) => sourceSlots.has(primitive.slot))];
      }
      pathDraws = pathDraws.filter((draw) =>
        draw.maskSource === true
          ? used.has(draw.nodeId)
          : plan.admit(pathClips.get(draw.nodeId) ?? null),
      );
    }
    let origin = this.#selectOrigin(cameraState.camera, assessed, target);
    let rebased =
      this.#origin === null || origin.x !== this.#origin.x || origin.y !== this.#origin.y;
    if (rebased) {
      this.#origin = origin;
      this.#originRevision = Symbol('primitive-origin');
    }

    try {
      this.#assertPackingBudget(assessed, cameraState.camera, target, origin);
    } catch (error) {
      const snapped = snapOrigin(cameraState.camera.position);
      if (snapped.x === origin.x && snapped.y === origin.y) throw error;
      this.#assertPackingBudget(assessed, cameraState.camera, target, snapped);
      origin = snapped;
      rebased = true;
      this.#origin = snapped;
      this.#originRevision = Symbol('primitive-origin');
    }

    // E23 contract, U2: gradient records for the drawn mesh paints, against the mesh origin. An
    // out-of-range record (E23-K8) skips its draw; a joint path skips both of its draws.
    this.#gradients.begin();
    const meshRecords = new Map<PathMeshDraw, GradientPaintRecord>();
    if (pathDraws.length > 0) {
      const pathById = new Map(paths.map((path) => [path.id, path] as const));
      const meshOrigin = this.#meshOrigin ?? { x: 0, y: 0 };
      const outOfRange = new Set<string>();
      for (const draw of pathDraws) {
        if (draw.maskSource === true) continue;
        const path = pathById.get(draw.nodeId)!;
        const role = draw.paint ?? 'fill';
        const paint = role === 'fill' ? path.node.style.fill : path.node.style.stroke?.color;
        if (paint === null || paint === undefined || !isSceneGradient(paint)) continue;
        const record = this.#gradients.recordOf(
          `mesh:${draw.nodeId}:${role}`,
          paint,
          path.world,
          meshOrigin,
        );
        if (record === null) outOfRange.add(`${draw.nodeId}:${role}`);
        else meshRecords.set(draw, record);
      }
      if (outOfRange.size > 0) {
        const jointDropped = new Set(
          pathDraws
            .filter(
              (draw) =>
                draw.composite === 'joint-fill' &&
                (outOfRange.has(`${draw.nodeId}:fill`) || outOfRange.has(`${draw.nodeId}:stroke`)),
            )
            .map((draw) => draw.nodeId),
        );
        pathDraws = pathDraws.filter(
          (draw) =>
            draw.maskSource === true ||
            !(
              jointDropped.has(draw.nodeId) ||
              outOfRange.has(`${draw.nodeId}:${draw.paint ?? 'fill'}`)
            ),
        );
      }
    }
    // Primitive records, against the primitive origin; an out-of-range paint keeps index 0, whose
    // transparent solid lanes contribute nothing (E23-K8).
    const primitivePaints: { slot: number; fill: number; stroke: number }[] = [];
    const paintFlags = visible.map((primitive) => {
      const { fill, stroke } = primitive.node.style;
      const fillIndex =
        fill !== null && isSceneGradient(fill)
          ? this.#gradients.indexOf(`primitive:${primitive.id}:fill`, fill, primitive.world, origin)
          : 0;
      const strokeIndex =
        stroke !== null && isSceneGradient(stroke.color)
          ? this.#gradients.indexOf(
              `primitive:${primitive.id}:stroke`,
              stroke.color,
              primitive.world,
              origin,
            )
          : 0;
      if (fillIndex === 0 && strokeIndex === 0) return false;
      primitivePaints.push(
        Object.freeze({ slot: primitive.slot, fill: fillIndex, stroke: strokeIndex }),
      );
      return true;
    });

    const grew = this.#ensureCapacities(highWater(this.#slotIds), visible.length);
    if (grew) rebased = true;
    this.#updateInstanceRecords(derived, origin, epochChanged || grew || rebased);
    this.#updateOrder(visible.map(({ slot }) => slot));
    this.#updateFrame(cameraState.camera.position, cameraState.camera.zoom, target, origin);

    const generationChanged = target.generation !== this.#activeGeneration;
    if (generationChanged) {
      this.#activeGeneration = target.generation;
      this.#pending = null;
    }
    const reconstruct =
      generationChanged ||
      epochChanged ||
      grew ||
      this.#reconstructedGeneration !== target.generation ||
      this.#reconstructedEpoch !== scene.sceneEpoch ||
      this.#reconstructedIncarnation !== this.#incarnations.transforms;
    const writes = this.#makeWrites(reconstruct);
    const packedMesh = this.#prepareMeshPart(
      target.generation,
      pathDraws,
      meshFrame,
      pathSequences,
    );
    // P4 contract, U4: mask source draws leave the paint-order draws for the clip part.
    const maskDrawIndices = new Map<string, number>();
    pathDraws.forEach((draw, index) => {
      if (draw.maskSource === true) maskDrawIndices.set(draw.nodeId, index);
    });
    const contentPathDraws =
      maskDrawIndices.size === 0 ? pathDraws : pathDraws.filter((draw) => draw.maskSource !== true);
    const mesh =
      packedMesh === undefined || maskDrawIndices.size === 0
        ? packedMesh
        : Object.freeze({
            ...packedMesh,
            draws: packedMesh.draws.filter((_, index) => pathDraws[index]!.maskSource !== true),
          });
    // E23 U2: mesh records join the table only for draws the mesh part carries, after the
    // primitive records; a joint fill draw also names its stroke's record (E23-K4).
    const meshGradients = (mesh?.draws ?? []).map((_, index) => {
      const record = meshRecords.get(contentPathDraws[index]!);
      return record === undefined ? 0 : this.#gradients.add(record);
    });
    const strokeGradients = (mesh?.draws ?? []).map((_, index) =>
      contentPathDraws[index]!.composite === 'joint-fill' ? (meshGradients[index + 1] ?? 0) : 0,
    );
    const gradients = this.#gradients.end();
    // P4 contract, U2: clip states are numbered in drawn paint order; a state change splits an
    // analytic run. An unclipped frame has no states and the P3 draws, unchanged.
    let clip: ClipStates = NO_CLIP_STATES;
    if (clipSeen.value) {
      // The mesh part's draws are the content path draws, in the same order.
      const meshStates = (mesh?.draws ?? []).map((draw, index) => ({
        sequence: draw.sequence,
        clip: pathClips.get(contentPathDraws[index]!.nodeId) ?? null,
      }));
      clip = this.#assignClipStates(visible, meshStates);
    } else if (this.#clipStatesUsed) {
      // Releases the previous frame's states once the scene has no clip left; a mask that
      // returns over budget is reported again.
      this.#clipStates.begin();
      this.#clipStates.end();
      this.#overBudget = new Set();
    }
    this.#clipStatesUsed = clipSeen.value;
    const layered =
      layerPlan === null || layerPlan.order.length === 0
        ? null
        : interleaveLayerDraws(
            visible,
            visible.map((primitive) => layerPlan.indexOf(primitive.layer)),
            mesh?.draws.map((draw) => draw.sequence) ?? [],
            contentPathDraws.map((draw) => layerPlan.indexOf(pathLayers.get(draw.nodeId))),
            layerPlan.order.map((layer, index) => ({
              layer: index,
              target: layerPlan.indexOf(layer.parent),
              sequence: layer.start,
              depth: layer.depth,
            })),
            clip.primitiveStates,
            primitivePaints.length === 0 ? [] : paintFlags,
            layerPlan.order.length,
          );
    const draws =
      layered?.main ??
      interleaveDraws(
        visible,
        mesh?.draws.map((draw) => draw.sequence) ?? [],
        clip.primitiveStates,
        primitivePaints.length === 0 ? [] : paintFlags,
      );
    const meshFillDraws = (mesh?.draws ?? []).map((draw, index) =>
      Object.freeze({
        position: layered === null ? draws.positions[index]! : layered.meshPositions[index]!,
        ...draw.draw,
        ...((clip.meshStates[index] ?? 0) === 0 ? {} : { clipState: clip.meshStates[index]! }),
        ...(meshGradients[index] === 0 ? {} : { gradient: meshGradients[index]! }),
        ...(strokeGradients[index] === 0 ? {} : { strokeGradient: strokeGradients[index]! }),
      }),
    );
    const meshTargets =
      layered === null
        ? null
        : contentPathDraws.map((draw) => layerPlan!.indexOf(pathLayers.get(draw.nodeId)));
    const mainMeshDraws =
      meshTargets === null
        ? meshFillDraws
        : meshFillDraws.filter((_, index) => meshTargets[index] === -1);
    const layerNotices = this.#layerNotices.slice(0, LAYER_NOTICES_PER_PACKET);
    const layersPart: LayerPacketPart | null =
      layered === null && layerNotices.length === 0
        ? null
        : Object.freeze({
            layoutVersion: 0 as const,
            layers: Object.freeze(
              (layerPlan?.order ?? []).map((layer, index) =>
                Object.freeze({
                  nodeId: layer.nodeId,
                  opacity: layer.opacity,
                  bound: layerPlan!.bounds.get(layer)!,
                  parent: layerPlan!.indexOf(layer.parent),
                  draws: Object.freeze(layered?.layers[index] ?? []),
                  meshDraws: Object.freeze(
                    meshFillDraws.filter((_, draw) => meshTargets?.[draw] === index),
                  ),
                }),
              ),
            ),
            composites: Object.freeze(layered?.composites ?? []),
            notices: Object.freeze(layerNotices),
          });
    const packetId = Symbol('primitive-packet');
    const packet: PrimitivePacket = Object.freeze({
      layoutVersion: 1,
      scene: copyVersion(scene.version),
      sceneEpoch: scene.sceneEpoch,
      cameraRevision: cameraState.revision,
      surfaceRevision: target.surfaceRevision,
      originRevision: this.#originRevision,
      generation: target.generation,
      packetId,
      mode: reconstruct ? 'reconstruct' : 'incremental',
      resources: Object.freeze(this.#resources()),
      writes: Object.freeze(writes),
      draws: Object.freeze(draws.analytic),
      frame: Object.freeze({ ...target }),
      ...(this.#maskNotices.length === 0
        ? {}
        : { clipNotices: Object.freeze(this.#maskNotices.slice(0, MASK_NOTICES_PER_PACKET)) }),
      ...(layersPart === null ? {} : { layers: layersPart }),
      ...(clip.records.length === 0
        ? {}
        : {
            clip: Object.freeze({
              layoutVersion: 0 as const,
              states: clip.records,
              maxIndex: clip.records[clip.records.length - 1]!.index,
              masks: maskLevels(masks, packedMesh?.draws ?? [], maskDrawIndices),
              origin: Object.freeze({ x: origin.x, y: origin.y }),
              camera: Object.freeze({
                x: cameraState.camera.position.x,
                y: cameraState.camera.position.y,
                zoom: cameraState.camera.zoom,
              }),
            }),
          }),
      ...(gradients.records.length === 0
        ? {}
        : {
            paint: Object.freeze({
              layoutVersion: 0 as const,
              records: gradients.records,
              primitives: Object.freeze(primitivePaints),
              origin: Object.freeze({ x: origin.x, y: origin.y }),
              meshOrigin: Object.freeze({
                x: this.#meshOrigin?.x ?? 0,
                y: this.#meshOrigin?.y ?? 0,
              }),
              builds: gradients.builds,
            }),
          }),
      ...(mesh === undefined
        ? {}
        : {
            mesh: Object.freeze({
              layoutVersion: mesh.part.layoutVersion,
              originRevision: mesh.part.originRevision,
              resources: mesh.part.resources,
              writes: mesh.part.writes,
              draws: Object.freeze(mainMeshDraws),
              notices: mesh.part.notices,
            }),
          }),
    });
    // Notices leave the queue only once the packet exists, so a throwing prepare keeps them.
    this.#maskNotices.splice(0, packet.clipNotices?.length ?? 0);
    this.#layerNotices.splice(0, packet.layers?.notices.length ?? 0);
    this.#pending = Object.freeze({
      packet,
      expected: expectedRecords(writes),
      meshExpected: mesh?.expected ?? null,
    });
    this.#prepareSerial += 1;
    if (this.#pathMeshes !== undefined) {
      // E25: layer draws keep layer-local positions; scenes with layers are outside the E10
      // count pass, so the record matches `mesh.draws` only without layers.
      this.#drawRecord = drawRecord(
        this.#prepareSerial,
        contentPathDraws,
        meshFillDraws,
        this.#pathMeshes.hasFringeBuilder,
      );
    }
    return packet;
  }

  /**
   * P4 contract, U4: the frame's mask plan. A primitive source draws its fill area from its
   * instance records, a path source the fill draw the path pipeline served for it (P4-K2); a
   * degenerate primitive, a line, or a path without a served draw covers nothing.
   */
  #planMasks(
    scene: RetainedSceneView,
    derived: readonly DerivedPrimitive[],
    pathDraws: readonly PathMeshDraw[],
    camera: Readonly<{ position: Readonly<{ x: number; y: number }>; zoom: number }>,
    target: PrimitiveTarget,
  ): MaskPlan {
    const primitives = new Map(derived.map((primitive) => [primitive.id, primitive] as const));
    const sources = new Map(
      pathDraws.flatMap((draw) => (draw.maskSource === true ? [[draw.nodeId, draw] as const] : [])),
    );
    const sourceOf = (
      level: ClipMaskLevel,
    ): Readonly<{ source: MaskSourceRecord; key: string }> | null => {
      if (level.sourceId === null) return null;
      const primitive = primitives.get(level.sourceId);
      if (primitive !== undefined) {
        if (primitive.omitted || primitive.node.geometry.kind === 'line') return null;
        return {
          source: Object.freeze({ kind: 'primitive', slot: primitive.slot }),
          key: JSON.stringify(['primitive', primitive.node.geometry, primitive.world]),
        };
      }
      const draw = sources.get(level.sourceId);
      const node = scene.getNode(level.sourceId);
      if (draw === undefined || node?.kind !== 'path') return null;
      return {
        source: Object.freeze({ kind: 'mesh', nodeId: level.sourceId }),
        key: JSON.stringify([
          'mesh',
          scene.getGeometryRevision(level.sourceId) ?? 0,
          node.geometry.fillRule,
          composeSceneAffine(level.world, node.transform),
          draw.toleranceExponent,
          draw.fringeBucket,
        ]),
      };
    };
    return new MaskPlan({
      sourceOf,
      camera: { x: camera.position.x, y: camera.position.y, zoom: camera.zoom },
      target,
    });
  }

  /**
   * E25 contract, section 4: the frame's drawn layers. Bounds (E25-K5) are built bottom-up over
   * the drawn content, then clamped top-down to the parent's bound; a layer with an empty bound,
   * or inside one, is not drawn. Layer trees then pass the budget in paint order.
   */
  #planLayers(
    scopes: readonly LayerScope[],
    visible: readonly DerivedPrimitive[],
    pathDraws: readonly PathMeshDraw[],
    paths: ReadonlyMap<string, DerivedPath>,
    pathLayers: ReadonlyMap<string, LayerScope>,
    camera: Readonly<{ position: Readonly<{ x: number; y: number }>; zoom: number }>,
    target: PrimitiveTarget,
  ): DrawnLayers {
    const content = new Map<LayerScope, SceneBounds[]>();
    const add = (layer: LayerScope | null | undefined, bounds: SceneBounds | null) => {
      if (layer === null || layer === undefined || bounds === null) return;
      const list = content.get(layer);
      if (list === undefined) content.set(layer, [bounds]);
      else list.push(bounds);
    };
    for (const primitive of visible) add(primitive.layer, primitive.worldBounds);
    for (const draw of pathDraws) {
      if (draw.maskSource === true) continue;
      const layer = pathLayers.get(draw.nodeId);
      if (layer === undefined) continue;
      const path = paths.get(draw.nodeId)!;
      const points = path.node.geometry.points;
      const local = draw.paint === 'stroke' ? null : getPathLocalPointBounds(points);
      if (local !== null) add(layer, transformSceneBounds(local, path.world));
      // A joint fill draw also covers its stroke (ST-U7 addendum).
      if (draw.paint === 'stroke' || draw.composite === 'joint-fill') {
        const stroke = getPathLocalStrokeBounds(points, path.node.style.stroke);
        if (stroke !== null) add(layer, transformSceneBounds(stroke, path.world));
      }
    }
    const view = { x: camera.position.x, y: camera.position.y, zoom: camera.zoom };
    // Scopes are in pre-order, so the reverse visits every layer after the layers nested in it.
    const unclamped = new Map<LayerScope, DeviceRect>();
    const nested = new Map<LayerScope, DeviceRect[]>();
    for (let index = scopes.length - 1; index >= 0; index -= 1) {
      const scope = scopes[index]!;
      const bound = layerBound(
        content.get(scope) ?? [],
        nested.get(scope) ?? [],
        scope.chain,
        view,
        target,
        null,
      );
      if (bound === null || scope.parent === null) {
        if (bound !== null) unclamped.set(scope, bound);
        continue;
      }
      unclamped.set(scope, bound);
      const siblings = nested.get(scope.parent);
      if (siblings === undefined) nested.set(scope.parent, [bound]);
      else siblings.push(bound);
    }
    const bounds = new Map<LayerScope, DeviceRect>();
    for (const scope of scopes) {
      const own = unclamped.get(scope);
      if (own === undefined) continue;
      if (scope.parent === null) {
        bounds.set(scope, own);
        continue;
      }
      const parent = bounds.get(scope.parent);
      const clamped = parent === undefined ? null : intersectRects(own, parent);
      if (clamped !== null) bounds.set(scope, clamped);
    }
    // Section 4, Budget: trees in paint order, each with its drawn layers.
    const trees = new Map<LayerScope, { width: number; height: number }[]>();
    for (const scope of scopes) {
      const bound = bounds.get(scope);
      if (bound === undefined) continue;
      let root = scope;
      while (root.parent !== null) root = root.parent;
      const list = trees.get(root);
      if (list === undefined) trees.set(root, [bound]);
      else list.push(bound);
    }
    const budget = planLayerBudget(
      [...trees].map(([root, layers]) => ({ rootId: root.nodeId, layers })),
      target.sampleCount,
    );
    this.#queueLayerNotices(budget.notices);
    const order = scopes
      .filter((scope) => {
        if (!bounds.has(scope)) return false;
        let root = scope;
        while (root.parent !== null) root = root.parent;
        return budget.admitted.has(root.nodeId);
      })
      .sort(
        (left, right) =>
          left.end - right.end || right.start - left.start || right.depth - left.depth,
      );
    const indices = new Map(order.map((scope, index) => [scope, index] as const));
    return {
      indices: new Set(order),
      order,
      bounds,
      indexOf: (layer) => (layer === null || layer === undefined ? -1 : (indices.get(layer) ?? -1)),
    };
  }

  #queueLayerNotices(notices: readonly LayerResourceNotice[]): void {
    const current = new Set(notices.map((notice) => notice.nodeId));
    for (const notice of notices) {
      if (this.#layersOverBudget.has(notice.nodeId)) continue;
      if (this.#layerNotices.length < LAYER_NOTICES_QUEUED) this.#layerNotices.push(notice);
      else this.#layerNoticesDropped += 1;
    }
    this.#layersOverBudget = current;
  }

  /** E25 contract, section 5: layer budget notices dropped because the queue was full. */
  public getLayerNoticesDropped(): number {
    return this.#layerNoticesDropped;
  }

  #queueMaskNotices(notices: readonly MaskBudgetNotice[]): void {
    const current = new Set(notices.map((notice) => notice.nodeId));
    for (const notice of notices) {
      if (this.#overBudget.has(notice.nodeId)) continue;
      if (this.#maskNotices.length < MASK_NOTICES_QUEUED) this.#maskNotices.push(notice);
      else this.#maskNoticesDropped += 1;
    }
    this.#overBudget = current;
  }

  /** P4 contract, section 5: budget notices dropped because the queue was full. */
  public getMaskNoticesDropped(): number {
    return this.#maskNoticesDropped;
  }

  /** P4 contract, U2 (P4-A06): clip-state records written so far. */
  public getClipStateWrites(): number {
    return this.#clipStates.writes;
  }

  /**
   * P4 contract, U2: numbers the clip states of the drawn draws in paint order (primitives and
   * mesh draws merged by sequence; a mesh draw at a sequence follows the primitives before it).
   */
  #assignClipStates(
    visible: readonly DerivedPrimitive[],
    meshDraws: readonly Readonly<{ sequence: number; clip: ClipChain | null }>[],
  ): ClipStates {
    this.#clipStates.begin();
    const primitiveStates: number[] = [];
    const meshStates: number[] = [];
    let next = 0;
    for (const draw of meshDraws) {
      while (next < visible.length && visible[next]!.sequence < draw.sequence) {
        primitiveStates.push(this.#clipStates.stateOf(visible[next]!.clip));
        next += 1;
      }
      meshStates.push(this.#clipStates.stateOf(draw.clip));
    }
    for (; next < visible.length; next += 1) {
      primitiveStates.push(this.#clipStates.stateOf(visible[next]!.clip));
    }
    return { primitiveStates, meshStates, records: this.#clipStates.end() };
  }

  /** @internal Tests only (E10 contract, section 3.1): null before a prepare or without a port. */
  public getLastDrawRecordForTesting(): PathDrawRecordForTesting | null {
    return this.#drawRecord;
  }

  public getPathMeshStatistics(): PathMeshStatistics | null {
    return this.#pathMeshes?.getStatistics() ?? null;
  }

  /** @internal Tests only (ST-U7 addendum, ST-A17): the pipeline's overlay build count. */
  public getOverlayBuildCountForTesting(): number {
    return this.#pathMeshes?.getOverlayBuildCount() ?? 0;
  }

  /** @internal Tests only (E24-A04): dash expansions of the path-mesh pipeline so far. */
  public getDashExpansionCountForTesting(): number {
    return this.#pathMeshes?.getDashExpansionCount() ?? 0;
  }

  public acknowledge(receipt: PrimitiveReceipt): void {
    const pending = this.#pending;
    if (pending === null || !receiptMatchesPacket(receipt, pending.packet)) return;
    // P3 V3 section f: the receipt has a mesh part exactly when the packet has one; a packet
    // with a mesh part is acknowledged only when both parts validate.
    const meshPacket = pending.packet.mesh;
    const meshReceipt = receipt.mesh;
    if ((meshPacket === undefined) !== (meshReceipt === undefined)) return;
    let meshReceived: NonNullable<ReturnType<PathMeshPacker['validateReceipt']>> | null = null;
    let meshSkipped = false;
    if (meshPacket !== undefined && meshReceipt !== undefined) {
      if (meshReceipt.status === 'skipped') {
        meshSkipped = true;
      } else if (meshReceipt.status === 'submitted') {
        if (meshReceipt.originRevision !== meshPacket.originRevision) return;
        meshReceived = this.#meshPacker.validateReceipt(
          meshReceipt.resources,
          pending.meshExpected ?? new Map(),
          meshPacket.resources.length,
        );
        if (meshReceived === null) return;
      } else {
        return;
      }
    }
    const received = validateReceiptResources(receipt, pending.expected, this.#incarnations);
    if (received === null) return;
    this.#pending = null;
    // A skipped part acknowledges only the P1 part and leaves every mesh record dirty; the
    // source stops producing mesh draws and writes for the rest of that generation.
    if (meshSkipped) this.#meshStoppedGeneration = receipt.generation;
    if (meshReceived !== null) this.#meshPacker.acknowledge(meshReceived);
    for (const [resourceId, records] of received) {
      for (const record of records) {
        if (this.#versions[resourceId][record.index] === record.version) {
          this.#versions[resourceId][record.index] = undefined;
        }
      }
    }
    if (pending.packet.mode === 'reconstruct') {
      this.#reconstructedGeneration = receipt.generation;
      this.#reconstructedEpoch = receipt.sceneEpoch;
      this.#reconstructedIncarnation = this.#incarnations.transforms;
    }
  }

  public getPreparationStatistics(): PrimitivePreparationStatistics {
    return Object.freeze({
      geometryBuilds: this.#geometryBuilds,
      recordWrites: Object.freeze({ ...this.#recordWrites }),
    });
  }

  public dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#gradients.clear();
    this.#sceneEpoch = null;
    this.#slots.clear();
    this.#slotIds = [];
    this.#buffers = {
      transforms: new Uint8Array(0),
      geometry: new Uint8Array(0),
      styles: new Uint8Array(0),
      order: new Uint8Array(0),
      frame: new Uint8Array(0),
    };
    this.#versions = createVersions();
    this.#values = { transforms: [], geometry: [], styles: [] };
    this.#orderValues = [];
    this.#frameValues = null;
    this.#pending = null;
    this.#derivedCache.clear();
    this.#packingKeys.clear();
    this.#pathMeshes?.dispose();
    this.#meshPacker.dispose();
  }

  /**
   * The optional mesh part (P3 V3 section f). It is absent without a port, and with a port
   * when the scene has no path slot and no pending notice, so a primitive-only packet keeps
   * P1's exact shape. Notices leave the queue only here, so a throwing prepare keeps them.
   */
  #prepareMeshPart(
    generation: number,
    pathDraws: readonly PathMeshDraw[],
    meshFrame: readonly number[] | null,
    sequences: ReadonlyMap<string, number>,
  ):
    | Readonly<{
        part: Omit<MeshPacketPart, 'draws'>;
        draws: ReadonlyArray<Readonly<{ sequence: number; draw: Omit<MeshFillDraw, 'position'> }>>;
        expected: ReturnType<PathMeshPacker['prepare']>['expected'] | null;
      }>
    | undefined {
    const pipeline = this.#pathMeshes;
    if (pipeline === undefined) return undefined;
    const slots = pipeline.getPathSlots();
    // B2 stroke contract, section 9.5: a stroked node's stroke has its own second slot.
    const strokeSlots = pipeline.getStrokeSlots();
    const notices = pipeline.takePacketNotices();
    if (slots.size === 0 && notices.length === 0) return undefined;
    if (slots.size === 0 || this.#meshStoppedGeneration === generation) {
      // A part holding notices only: no resources, writes or draws.
      return Object.freeze({
        part: Object.freeze({
          layoutVersion: 0 as const,
          originRevision: this.#meshOriginRevision,
          resources: Object.freeze([]),
          writes: Object.freeze([]),
          notices,
        }),
        draws: Object.freeze([]),
        expected: null,
      });
    }
    const output = this.#meshPacker.prepare({
      generation,
      draws: pathDraws,
      slots,
      ...(strokeSlots.size === 0 ? {} : { strokeSlots }),
      resident: pipeline.getResidentIds(),
      frameLanes: meshFrame,
    });
    return Object.freeze({
      part: Object.freeze({
        layoutVersion: 0 as const,
        originRevision: this.#meshOriginRevision,
        resources: output.resources,
        writes: output.writes,
        notices,
      }),
      draws: Object.freeze(
        pathDraws.map((draw) => {
          // A stroked path's fill and stroke draws share its sequence, so they get the same
          // paint position and stay consecutive, fill first (B2 section 9.5).
          const placement = (
            draw.paint === 'stroke' ? output.strokePlacements : output.placements
          ).get(draw.nodeId)!;
          return Object.freeze({
            sequence: sequences.get(draw.nodeId)!,
            draw: Object.freeze({
              instance: draw.slot,
              firstTriangle: placement.firstTriangle,
              triangleCount: placement.triangleCount,
              // ST-U7 addendum, section 4.5: only a joint fill draw carries the field.
              ...(draw.composite === undefined ? {} : { composite: draw.composite }),
            }),
          });
        }),
      ),
      expected: output.expected,
    });
  }

  #resetForSnapshot(scene: RetainedSceneView): void {
    const slots = new Map<string, number>();
    const slotIds: Array<string | undefined> = [];
    let slot = 0;
    for (const node of authoritativeTraversal(scene)) {
      if (node.kind !== 'primitive') continue;
      slots.set(node.id, slot);
      slotIds[slot] = node.id;
      slot += 1;
    }
    const primitiveCapacity = Math.max(this.#primitiveCapacity, capacityFor(slot));
    const orderCapacity = this.#orderCapacity;
    const buffers = createBuffers(primitiveCapacity, orderCapacity);
    const incarnations = createIncarnations();
    this.#sceneEpoch = scene.sceneEpoch;
    this.#slots = slots;
    this.#slotIds = slotIds;
    this.#primitiveCapacity = primitiveCapacity;
    this.#orderCapacity = orderCapacity;
    this.#incarnations = incarnations;
    this.#buffers = buffers;
    this.#versions = createVersions();
    this.#values = { transforms: [], geometry: [], styles: [] };
    this.#orderValues = [];
    this.#frameValues = null;
    this.#origin = null;
    this.#pending = null;
    this.#derivedCache.clear();
    this.#packingKeys.clear();
    this.#reconstructedEpoch = null;
    this.#reconstructedIncarnation = null;
  }

  #reconcileSlots(scene: RetainedSceneView): void {
    const primitiveIds = new Set(
      scene.nodes.filter((node) => node.kind === 'primitive').map((node) => node.id),
    );
    for (const [id, slot] of this.#slots) {
      if (primitiveIds.has(id)) continue;
      this.#slots.delete(id);
      this.#slotIds[slot] = undefined;
      this.#values.transforms[slot] = undefined;
      this.#values.geometry[slot] = undefined;
      this.#values.styles[slot] = undefined;
      this.#versions.transforms[slot] = undefined;
      this.#versions.geometry[slot] = undefined;
      this.#versions.styles[slot] = undefined;
      this.#packingKeys.delete(id);
    }
    const inserted = [...primitiveIds].filter((id) => !this.#slots.has(id)).sort(compareOrdinal);
    for (const id of inserted) {
      let slot = this.#slotIds.findIndex((entry) => entry === undefined);
      if (slot < 0) slot = this.#slotIds.length;
      this.#slots.set(id, slot);
      this.#slotIds[slot] = id;
    }
  }

  #selectOrigin(
    camera: Readonly<{ position: Readonly<{ x: number; y: number }>; zoom: number }>,
    visible: readonly DerivedPrimitive[],
    target: PrimitiveTarget,
  ): Origin {
    const current = this.#origin;
    if (
      current !== null &&
      Math.abs(camera.position.x - current.x) <= 512 &&
      Math.abs(camera.position.y - current.y) <= 512
    ) {
      try {
        this.#assertPackingBudget(visible, camera, target, current);
        return current;
      } catch {
        // Retry once with the current-camera anchor below.
      }
    }
    return snapOrigin(camera.position);
  }

  #assertPackingBudget(
    primitives: readonly DerivedPrimitive[],
    camera: Readonly<{ position: Readonly<{ x: number; y: number }>; zoom: number }>,
    target: PrimitiveTarget,
    origin: Origin,
  ): void {
    for (const primitive of primitives) {
      const assessment = assessPrimitivePacking(
        primitive.world,
        primitive.localBounds,
        origin,
        camera.position,
        camera.zoom,
        target.devicePixelRatio,
        target.width,
        target.height,
        primitive.node,
      );
      if (
        assessment.quantizationPhysicalPixels > 0.125 ||
        assessment.arithmeticPhysicalPixels > 0.125
      ) {
        throw new PrimitiveNumericPreparationError('packet v1 position precision budget exceeded');
      }
    }
  }

  #ensureCapacities(primitiveDemand: number, orderDemand: number): boolean {
    const primitiveCapacity = Math.max(this.#primitiveCapacity, capacityFor(primitiveDemand));
    const orderCapacity = Math.max(this.#orderCapacity, capacityFor(orderDemand));
    if (primitiveCapacity === this.#primitiveCapacity && orderCapacity === this.#orderCapacity)
      return false;
    const buffers = createBuffers(primitiveCapacity, orderCapacity);
    this.#primitiveCapacity = primitiveCapacity;
    this.#orderCapacity = orderCapacity;
    this.#buffers = buffers;
    this.#incarnations = createIncarnations();
    this.#versions = createVersions();
    this.#values = { transforms: [], geometry: [], styles: [] };
    this.#packingKeys.clear();
    this.#orderValues = [];
    this.#frameValues = null;
    this.#pending = null;
    this.#reconstructedIncarnation = null;
    return true;
  }

  #updateInstanceRecords(
    primitives: readonly DerivedPrimitive[],
    origin: Origin,
    forceTransforms: boolean,
  ): void {
    for (const primitive of primitives) {
      const previous = this.#packingKeys.get(primitive.id);
      const transformKey = [...primitive.world, origin.x, origin.y];
      const geometryKey = primitiveGeometryKey(primitive.node);
      const styleKey = primitiveStyleKey(primitive.node);
      if (forceTransforms || !numericArraysEqual(previous?.transform, transformKey)) {
        assertPackedTransform(primitive.world, origin);
        this.#setInstanceRecord(
          'transforms',
          primitive.slot,
          [
            primitive.world[0],
            primitive.world[1],
            primitive.world[2],
            primitive.world[3],
            primitive.world[4] - origin.x,
            primitive.world[5] - origin.y,
            0,
            0,
          ],
          forceTransforms,
        );
      }
      if (!numericArraysEqual(previous?.geometry, geometryKey)) {
        this.#geometryBuilds += 1;
        this.#setInstanceRecord('geometry', primitive.slot, packGeometry(primitive.node), false);
      }
      if (!numericArraysEqual(previous?.style, styleKey)) {
        this.#setInstanceRecord('styles', primitive.slot, packStyle(primitive.node), false);
      }
      this.#packingKeys.set(
        primitive.id,
        Object.freeze({
          transform: Object.freeze(transformKey),
          geometry: Object.freeze(geometryKey),
          style: Object.freeze(styleKey),
        }),
      );
    }
  }

  #setInstanceRecord(
    resource: InstanceResource,
    slot: number,
    lanes: readonly number[],
    force: boolean,
  ): void {
    if (!force && numericArraysEqual(this.#values[resource][slot], lanes)) return;
    if (lanes.some((value) => !Number.isFinite(Math.fround(value)))) {
      throw new PrimitiveNumericPreparationError(`${resource} cannot be represented in packet v1`);
    }
    writePackedRecord(this.#buffers[resource], slot * PRIMITIVE_STRIDES[resource], resource, lanes);
    this.#recordWrites[resource] += 1;
    this.#values[resource][slot] = lanes;
    this.#versions[resource][slot] = Symbol(`${resource}-${slot}`);
  }

  #updateOrder(order: readonly number[]): void {
    const buffer = this.#buffers.order;
    const view = new DataView(buffer.buffer, buffer.byteOffset);
    for (let index = 0; index < order.length; index += 1) {
      if (this.#orderValues[index] === order[index]) continue;
      view.setUint32(index * 4, order[index]!, true);
      this.#recordWrites.order += 1;
      this.#versions.order[index] = Symbol(`order-${index}`);
    }
    this.#orderValues = [...order];
    this.#versions.order.length = order.length;
  }

  #updateFrame(
    camera: Readonly<{ x: number; y: number }>,
    zoom: number,
    target: PrimitiveTarget,
    origin: Origin,
  ): void {
    const lanes = [
      origin.x - camera.x,
      origin.y - camera.y,
      zoom,
      target.devicePixelRatio,
      target.width,
      target.height,
      0,
      0,
    ];
    if (
      lanes.some((value) => !Number.isFinite(Math.fround(value))) ||
      Math.fround(zoom) <= 0 ||
      Math.fround(target.devicePixelRatio) <= 0
    ) {
      throw new PrimitiveNumericPreparationError('frame cannot be represented in packet v1');
    }
    if (numericArraysEqual(this.#frameValues, lanes)) return;
    const view = new DataView(this.#buffers.frame.buffer, this.#buffers.frame.byteOffset);
    lanes.forEach((value, index) => view.setFloat32(index * 4, value, true));
    this.#recordWrites.frame += 1;
    this.#frameValues = Object.freeze(lanes);
    this.#versions.frame[0] = Symbol('frame-0');
  }

  #makeWrites(reconstruct: boolean): PrimitiveWrite[] {
    const writes: PrimitiveWrite[] = [];
    for (const resourceId of RESOURCE_ORDER) {
      const indices = reconstruct
        ? this.#reconstructionIndices(resourceId)
        : dirtyIndices(this.#versions[resourceId]);
      for (const range of contiguousRanges(indices)) {
        const stride = PRIMITIVE_STRIDES[resourceId];
        const records: PrimitiveRecordVersion[] = [];
        for (let index = range.first; index <= range.last; index += 1) {
          let version = this.#versions[resourceId][index];
          if (version === undefined) {
            version = Symbol(`${resourceId}-${index}`);
            this.#versions[resourceId][index] = version;
          }
          records.push(Object.freeze({ index, version }));
        }
        writes.push(
          Object.freeze({
            resourceId,
            incarnation: this.#incarnations[resourceId],
            byteOffset: range.first * stride,
            bytes: this.#buffers[resourceId].slice(range.first * stride, (range.last + 1) * stride),
            records: Object.freeze(records),
          }),
        );
      }
    }
    return writes;
  }

  #reconstructionIndices(resourceId: PrimitiveResourceId): number[] {
    if (resourceId === 'frame') return [0];
    if (resourceId === 'order') return this.#orderValues.map((_, index) => index);
    return this.#slotIds.flatMap((id, index) => (id === undefined ? [] : [index]));
  }

  #resources(): PrimitiveResource[] {
    return RESOURCE_ORDER.map((id) =>
      Object.freeze({
        id,
        incarnation: this.#incarnations[id],
        capacityBytes: this.#buffers[id].byteLength,
      }),
    );
  }
}

function derivePrimitives(
  scene: RetainedSceneView,
  slots: ReadonlyMap<string, number>,
  cache: Map<string, DerivedCacheEntry>,
  paths: DerivedPath[],
  pathSequences: Map<string, number>,
  clipSeen: { value: boolean },
  layerScopes: LayerScope[],
  pathLayers: Map<string, LayerScope>,
  isolateUnitOpacity = false,
): DerivedPrimitive[] {
  const result: DerivedPrimitive[] = [];
  const present = new Set<string>();
  let sequence = 0;
  const rootWorldVersion = Symbol.for('vector-studio.primitive-root-world');
  const stack: {
    id: string;
    parentWorld: SceneAffine;
    parentWorldVersion: symbol;
    parentHidden: boolean;
    chain: ClipChain | null;
    maskSource: boolean;
    /** For a mask source: the mask container's own chain, which its fill draw is clipped by. */
    sourceChain: ClipChain | null;
    /** E25 contract, U2: the innermost isolated container above the node. */
    layer: LayerScope | null;
  }[] = [...scene.rootOrder].reverse().map((id) => ({
    id,
    parentWorld: IDENTITY,
    parentWorldVersion: rootWorldVersion,
    parentHidden: false,
    chain: null,
    maskSource: false,
    sourceChain: null,
    layer: null,
  }));
  // E25 contract, U2: a leaf extends every enclosing layer's sequence range.
  const extendLayers = (layer: LayerScope | null) => {
    for (let scope = layer; scope !== null; scope = scope.parent) scope.end = sequence + 1;
  };
  while (stack.length > 0) {
    const item = stack.pop()!;
    const node = scene.getNode(item.id)!;
    present.add(node.id);
    const previous = cache.get(node.id);
    const worldChanged =
      previous === undefined ||
      previous.parentWorldVersion !== item.parentWorldVersion ||
      !numericArraysEqual(previous.transform, node.transform);
    const world = worldChanged
      ? composeSceneAffine(item.parentWorld, node.transform)!
      : previous.world;
    const worldVersion = worldChanged ? Symbol(`world-${node.id}`) : previous.worldVersion;
    // P4-S2: a mask source never paints, whatever its visibility.
    const hidden = item.parentHidden || !node.visible || item.maskSource;
    if (node.kind === 'container') {
      if (node.clip !== null) clipSeen.value = true;
      const isMask = node.clip?.kind === 'mask';
      const source = isMask ? scene.getNode(node.children[0] ?? '') : undefined;
      const chain = extendClipChain(
        item.chain,
        node,
        world,
        source,
        source === undefined ? null : composeSceneAffine(world, source.transform),
      );
      // E25-K3: opacity 0 draws nothing of the subtree, as `visible: false` does (P4-K2b); E25-K1:
      // a visible container with 0 < opacity < 1 is a layer.
      const subtreeHidden = hidden || node.opacity === 0;
      let layer = item.layer;
      if (!subtreeHidden && (node.opacity < 1 || isolateUnitOpacity)) {
        layer = {
          nodeId: node.id,
          opacity: node.opacity,
          parent: item.layer,
          depth: item.layer === null ? 0 : item.layer.depth + 1,
          chain,
          start: sequence,
          end: sequence,
        };
        layerScopes.push(layer);
      }
      cache.set(
        node.id,
        Object.freeze({
          transform: node.transform,
          parentWorldVersion: item.parentWorldVersion,
          worldVersion,
          world,
          hidden,
          localKey: null,
          localBounds: null,
          worldBounds: null,
          omitted: false,
        }),
      );
      for (let index = node.children.length - 1; index >= 0; index -= 1) {
        stack.push({
          id: node.children[index]!,
          parentWorld: world,
          parentWorldVersion: worldVersion,
          parentHidden: subtreeHidden,
          chain,
          maskSource: isMask && index === 0,
          sourceChain: item.chain,
          layer,
        });
      }
      continue;
    }
    if (node.kind === 'path') {
      cache.set(
        node.id,
        Object.freeze({
          transform: node.transform,
          parentWorldVersion: item.parentWorldVersion,
          worldVersion,
          world,
          hidden,
          localKey: null,
          localBounds: null,
          worldBounds: null,
          omitted: false,
        }),
      );
      // P4-S2 and P4-Q3: a mask source is meshed as a fill whatever its style and visibility,
      // clipped by its container's own chain, and never paints.
      paths.push(
        Object.freeze(
          item.maskSource
            ? {
                id: node.id,
                node,
                world,
                hidden: item.parentHidden || item.chain?.empty === true,
                maskSource: true as const,
                ...(item.sourceChain === null ? {} : { clip: item.sourceChain }),
              }
            : {
                id: node.id,
                node,
                world,
                hidden: hidden || item.chain?.empty === true,
                ...(item.chain === null ? {} : { clip: item.chain }),
              },
        ),
      );
      pathSequences.set(node.id, sequence);
      if (item.layer !== null) pathLayers.set(node.id, item.layer);
      extendLayers(item.layer);
      sequence += 1;
      continue;
    }
    const localKey = primitiveBoundsKey(node);
    const boundsChanged =
      worldChanged || previous === undefined || !numericArraysEqual(previous.localKey, localKey);
    const localBounds = boundsChanged
      ? getPrimitiveLocalStrokeBounds(node)!
      : previous.localBounds!;
    const worldBounds = boundsChanged
      ? transformSceneBounds(localBounds, world)!
      : previous.worldBounds!;
    const omitted = boundsChanged ? isDegenerate(node, world) : previous.omitted;
    cache.set(
      node.id,
      Object.freeze({
        transform: node.transform,
        parentWorldVersion: item.parentWorldVersion,
        worldVersion,
        world,
        hidden,
        localKey,
        localBounds,
        worldBounds,
        omitted,
      }),
    );
    result.push(
      Object.freeze({
        id: node.id,
        slot: slots.get(node.id)!,
        node,
        world,
        localBounds,
        worldBounds,
        hidden,
        omitted,
        clip: item.chain,
        sequence,
        layer: item.layer,
      }),
    );
    extendLayers(item.layer);
    sequence += 1;
  }
  for (const id of cache.keys()) if (!present.has(id)) cache.delete(id);
  return result;
}

/**
 * P3 V3 section g: visible primitives append to the order stream as in P1; a path that emits a
 * mesh draw closes the current analytic run, and its position is the number of analytic draws
 * so far. Paths without a draw split nothing, so a scene without drawn paths emits P1's single
 * analytic draw over the whole visible order stream.
 */
type ClipStates = Readonly<{
  primitiveStates: readonly number[];
  meshStates: readonly number[];
  records: readonly ClipStateRecord[];
}>;
const NO_CLIP_STATES: ClipStates = Object.freeze({
  primitiveStates: Object.freeze([]),
  meshStates: Object.freeze([]),
  records: Object.freeze([]),
});

/**
 * P4 contract, U4: the clip part's mask levels with each mesh source's packed draw; a mesh
 * source whose draw did not reach the packet (the mesh path stopped) covers nothing.
 */
function maskLevels(
  plan: MaskPlan | null,
  packed: ReadonlyArray<Readonly<{ draw: Omit<MeshFillDraw, 'position'> }>>,
  indices: ReadonlyMap<string, number>,
): readonly ClipMaskPacketLevel[] {
  if (plan === null) return Object.freeze([]);
  return Object.freeze(
    plan.levels.map((level): ClipMaskPacketLevel => {
      if (level.source.kind !== 'mesh') return { ...level, source: level.source };
      const index = indices.get(level.source.nodeId);
      const draw = index === undefined ? undefined : packed[index]?.draw;
      return Object.freeze({
        ...level,
        source: Object.freeze({
          ...level.source,
          draw:
            draw === undefined
              ? null
              : Object.freeze({
                  instance: draw.instance,
                  firstTriangle: draw.firstTriangle,
                  triangleCount: draw.triangleCount,
                }),
        }),
      });
    }),
  );
}

function interleaveDraws(
  visible: readonly DerivedPrimitive[],
  meshSequences: readonly number[],
  states: readonly number[],
  paints: readonly boolean[],
): Readonly<{ analytic: PrimitiveDraw[]; positions: number[] }> {
  const analytic: PrimitiveDraw[] = [];
  const positions: number[] = [];
  let runStart = 0;
  let next = 0;
  const close = () => {
    if (next > runStart) {
      const state = states[runStart] ?? 0;
      analytic.push(
        Object.freeze({
          first: runStart,
          count: next - runStart,
          variant: 'analytic-v1' as const,
          // P4 contract, U2: present only on a clipped run, so P3 draws stay unchanged.
          ...(state === 0 ? {} : { clipState: state }),
          // E23 contract, U2: present only on a gradient run.
          ...(paints[runStart] === true ? { paint: 'gradient' as const } : {}),
        }),
      );
      runStart = next;
    }
  };
  // P4 contract, U2: a clip-state change closes the run; the order is never changed. E23 U2: so
  // does a change between a solid and a gradient primitive.
  const advanceTo = (end: number) => {
    // A frame without clip states or gradients: the P3 jump, without a per-primitive walk.
    if (states.length === 0 && paints.length === 0) {
      next = Math.max(next, end);
      return;
    }
    while (next < end) {
      if (
        next > runStart &&
        ((states[next] ?? 0) !== (states[runStart] ?? 0) ||
          (paints[next] ?? false) !== (paints[runStart] ?? false))
      ) {
        close();
      }
      next += 1;
    }
  };
  for (const sequence of meshSequences) {
    let end = next;
    while (end < visible.length && visible[end]!.sequence < sequence) end += 1;
    advanceTo(end);
    close();
    positions.push(analytic.length);
  }
  advanceTo(visible.length);
  close();
  return { analytic, positions };
}

/** E25 contract, U2: the frame's drawn layers, indexed in post-order. */
type DrawnLayers = Readonly<{
  indices: ReadonlySet<LayerScope>;
  order: readonly LayerScope[];
  bounds: ReadonlyMap<LayerScope, DeviceRect>;
  /** The layer's index in `order`, or -1 for the main pass. */
  indexOf(layer: LayerScope | null | undefined): number;
}>;

function intersectRects(left: DeviceRect, right: DeviceRect): DeviceRect | null {
  const x = Math.max(left.x, right.x);
  const y = Math.max(left.y, right.y);
  const width = Math.min(left.x + left.width, right.x + right.width) - x;
  const height = Math.min(left.y + left.height, right.y + right.height) - y;
  return width > 0 && height > 0 ? Object.freeze({ x, y, width, height }) : null;
}

type LayerComposite = LayerPacketPart['composites'][number];

/**
 * E25 contract, section 4: `interleaveDraws` over several targets, the main pass (-1) and each
 * layer. Primitives, mesh draws and composites are merged in paint order; a composite sits at
 * its layer's first sequence, before that leaf, outer layers first. A run extends only over
 * consecutive order-stream entries of one target with equal clip state and paint; a mesh draw or
 * a composite closes its target's run.
 */
function interleaveLayerDraws(
  visible: readonly DerivedPrimitive[],
  visibleTargets: readonly number[],
  meshSequences: readonly number[],
  meshTargets: readonly number[],
  composites: readonly Readonly<{
    layer: number;
    target: number;
    sequence: number;
    depth: number;
  }>[],
  states: readonly number[],
  paints: readonly boolean[],
  layerCount: number,
): Readonly<{
  main: Readonly<{ analytic: PrimitiveDraw[]; positions: number[] }>;
  meshPositions: number[];
  layers: PrimitiveDraw[][];
  composites: LayerComposite[];
}> {
  type Run = {
    analytic: PrimitiveDraw[];
    start: number;
    next: number;
    lastPosition: number;
    atPosition: number;
  };
  const runs: Run[] = Array.from({ length: layerCount + 1 }, () => ({
    analytic: [],
    start: -1,
    next: -1,
    lastPosition: -1,
    atPosition: 0,
  }));
  const runOf = (target: number) => runs[target + 1]!;
  const close = (run: Run) => {
    if (run.start < 0) return;
    const state = states[run.start] ?? 0;
    run.analytic.push(
      Object.freeze({
        first: run.start,
        count: run.next - run.start,
        variant: 'analytic-v1' as const,
        ...(state === 0 ? {} : { clipState: state }),
        ...(paints[run.start] === true ? { paint: 'gradient' as const } : {}),
      }),
    );
    run.start = -1;
  };
  const ordered = [...composites].sort(
    (left, right) => left.sequence - right.sequence || left.depth - right.depth,
  );
  const meshPositions: number[] = [];
  const mainPositions: number[] = [];
  const placed: LayerComposite[] = [];
  let primitive = 0;
  let composite = 0;
  const advanceTo = (sequence: number, inclusive: boolean) => {
    for (;;) {
      const nextComposite = ordered[composite];
      const nextPrimitive = visible[primitive];
      const compositeDue =
        nextComposite !== undefined &&
        (inclusive ? nextComposite.sequence <= sequence : nextComposite.sequence < sequence);
      const primitiveDue = nextPrimitive !== undefined && nextPrimitive.sequence < sequence;
      if (!compositeDue && !primitiveDue) return;
      if (compositeDue && (!primitiveDue || nextComposite.sequence <= nextPrimitive.sequence)) {
        const run = runOf(nextComposite.target);
        close(run);
        const position = run.analytic.length;
        placed.push(
          Object.freeze({
            layer: nextComposite.layer,
            target: nextComposite.target,
            position,
            meshOrder: run.lastPosition === position ? run.atPosition : 0,
          }),
        );
        composite += 1;
        continue;
      }
      const index = primitive;
      const run = runOf(visibleTargets[index]!);
      if (
        run.start < 0 ||
        run.next !== index ||
        (states[index] ?? 0) !== (states[run.start] ?? 0) ||
        (paints[index] ?? false) !== (paints[run.start] ?? false)
      ) {
        close(run);
        run.start = index;
      }
      run.next = index + 1;
      primitive += 1;
    }
  };
  meshSequences.forEach((sequence, index) => {
    // Composites at the draw's own sequence precede it: they open the layers it is drawn in.
    advanceTo(sequence, true);
    const target = meshTargets[index]!;
    const run = runOf(target);
    close(run);
    const position = run.analytic.length;
    if (run.lastPosition === position) run.atPosition += 1;
    else {
      run.lastPosition = position;
      run.atPosition = 1;
    }
    meshPositions.push(position);
    if (target === -1) mainPositions.push(position);
  });
  advanceTo(Infinity, true);
  for (const run of runs) close(run);
  return {
    main: { analytic: runOf(-1).analytic, positions: mainPositions },
    meshPositions,
    layers: runs.slice(1).map((run) => run.analytic),
    composites: placed,
  };
}

function primitiveBoundsKey(
  node: Extract<RenderNodeSnapshot, { kind: 'primitive' }>,
): readonly number[] {
  const strokeWidth = node.style.stroke?.width ?? 0;
  if (node.geometry.kind === 'line') {
    return [
      2,
      node.geometry.start.x,
      node.geometry.start.y,
      node.geometry.end.x,
      node.geometry.end.y,
      strokeWidth,
    ];
  }
  return [
    node.geometry.kind === 'rectangle' ? 0 : 1,
    node.geometry.width,
    node.geometry.height,
    strokeWidth,
  ];
}

function primitiveGeometryKey(
  node: Extract<RenderNodeSnapshot, { kind: 'primitive' }>,
): readonly number[] {
  if (node.geometry.kind === 'rectangle') {
    return [0, node.geometry.width, node.geometry.height, ...node.geometry.cornerRadii];
  }
  if (node.geometry.kind === 'ellipse') return [1, node.geometry.width, node.geometry.height];
  return [
    2,
    node.geometry.start.x,
    node.geometry.start.y,
    node.geometry.end.x,
    node.geometry.end.y,
  ];
}

function primitiveStyleKey(
  node: Extract<RenderNodeSnapshot, { kind: 'primitive' }>,
): readonly number[] {
  const fill = node.style.fill === null ? null : paintColorLanes(node.style.fill);
  const stroke = node.style.stroke;
  const strokeColor = stroke === null ? null : paintColorLanes(stroke.color);
  return [
    fill === null ? 0 : 1,
    fill?.r ?? 0,
    fill?.g ?? 0,
    fill?.b ?? 0,
    fill?.a ?? 0,
    stroke === null ? 0 : 1,
    strokeColor?.r ?? 0,
    strokeColor?.g ?? 0,
    strokeColor?.b ?? 0,
    strokeColor?.a ?? 0,
    stroke?.width ?? 0,
    node.opacity,
  ];
}

function packGeometry(node: Extract<RenderNodeSnapshot, { kind: 'primitive' }>): readonly number[] {
  const lanes = Array<number>(12).fill(0);
  if (node.geometry.kind === 'rectangle') {
    lanes[0] = 0;
    lanes[2] = node.geometry.width;
    lanes[3] = node.geometry.height;
    lanes.splice(
      4,
      4,
      ...normalizeRectangleRadii(
        node.geometry.width,
        node.geometry.height,
        node.geometry.cornerRadii,
      ),
    );
  } else if (node.geometry.kind === 'ellipse') {
    lanes[0] = 1;
    lanes[2] = node.geometry.width;
    lanes[3] = node.geometry.height;
  } else {
    lanes[0] = 2;
    lanes.splice(
      8,
      4,
      node.geometry.start.x,
      node.geometry.start.y,
      node.geometry.end.x,
      node.geometry.end.y,
    );
  }
  return lanes;
}

function packStyle(node: Extract<RenderNodeSnapshot, { kind: 'primitive' }>): readonly number[] {
  const lanes = Array<number>(12).fill(0);
  if (node.style.fill !== null) {
    const fill = paintColorLanes(node.style.fill);
    lanes.splice(0, 4, fill.r, fill.g, fill.b, fill.a);
  }
  if (node.style.stroke !== null) {
    const { width } = node.style.stroke;
    const color = paintColorLanes(node.style.stroke.color);
    lanes.splice(4, 4, color.r, color.g, color.b, color.a);
    lanes[8] = width;
  }
  lanes[9] = node.opacity;
  lanes[10] = (node.style.fill === null ? 0 : 1) | (node.style.stroke === null ? 0 : 2);
  return lanes;
}

function assertPackedTransform(world: SceneAffine, origin: Origin): void {
  const lanes = [
    Math.fround(world[0]),
    Math.fround(world[1]),
    Math.fround(world[2]),
    Math.fround(world[3]),
    Math.fround(world[4] - origin.x),
    Math.fround(world[5] - origin.y),
  ];
  if (lanes.some((value) => !Number.isFinite(value))) {
    throw new PrimitiveNumericPreparationError('transform cannot be represented in packet v1');
  }
  const determinant = Math.fround(
    Math.fround(lanes[0]! * lanes[3]!) - Math.fround(lanes[1]! * lanes[2]!),
  );
  const cpuDeterminant = world[0] * world[3] - world[1] * world[2];
  if (!Number.isFinite(determinant) || (cpuDeterminant !== 0 && determinant === 0)) {
    throw new PrimitiveNumericPreparationError('transform is singular in packet v1');
  }
}

function cullPrimitives(
  primitives: readonly DerivedPrimitive[],
  camera: Readonly<{ position: Readonly<{ x: number; y: number }>; zoom: number }>,
  target: PrimitiveTarget,
): DerivedPrimitive[] {
  // P4-K5: also drop a primitive that misses its clip chain's bound (same 2 px guard).
  const guard = 2 / (camera.zoom * target.devicePixelRatio);
  const viewport = {
    minX: camera.position.x - guard,
    minY: camera.position.y - guard,
    maxX: camera.position.x + target.width / target.devicePixelRatio / camera.zoom + guard,
    maxY: camera.position.y + target.height / target.devicePixelRatio / camera.zoom + guard,
  };
  return primitives.filter(
    ({ worldBounds, clip }) =>
      worldBounds.maxX >= viewport.minX &&
      worldBounds.minX <= viewport.maxX &&
      worldBounds.maxY >= viewport.minY &&
      worldBounds.minY <= viewport.maxY &&
      meetsClipChain(worldBounds, clip, guard),
  );
}

function authoritativeTraversal(scene: RetainedSceneView): RenderNodeSnapshot[] {
  const result: RenderNodeSnapshot[] = [];
  const stack = [...scene.rootOrder].reverse();
  while (stack.length > 0) {
    const node = scene.getNode(stack.pop()!)!;
    result.push(node);
    if (node.kind === 'container') {
      for (let index = node.children.length - 1; index >= 0; index -= 1)
        stack.push(node.children[index]!);
    }
  }
  return result;
}

function isDegenerate(
  node: Extract<RenderNodeSnapshot, { kind: 'primitive' }>,
  world: SceneAffine,
): boolean {
  if (world[0] * world[3] - world[1] * world[2] === 0) return true;
  if (node.geometry.kind === 'line') {
    return (
      node.geometry.start.x === node.geometry.end.x && node.geometry.start.y === node.geometry.end.y
    );
  }
  return node.geometry.width === 0 || node.geometry.height === 0;
}

function snapOrigin(camera: Readonly<{ x: number; y: number }>): Origin {
  return Object.freeze({
    x: 256 * Math.floor(camera.x / 256),
    y: 256 * Math.floor(camera.y / 256),
  });
}

function capacityFor(demand: number): number {
  if (!Number.isSafeInteger(demand) || demand < 0)
    throw new RangeError('Invalid packet capacity demand.');
  let capacity = 16;
  while (capacity < demand) {
    capacity *= 2;
    if (!Number.isSafeInteger(capacity)) throw new RangeError('Packet capacity overflow.');
  }
  return capacity;
}

function createBuffers(primitiveCapacity: number, orderCapacity: number) {
  return {
    transforms: new Uint8Array(primitiveCapacity * PRIMITIVE_STRIDES.transforms),
    geometry: new Uint8Array(primitiveCapacity * PRIMITIVE_STRIDES.geometry),
    styles: new Uint8Array(primitiveCapacity * PRIMITIVE_STRIDES.styles),
    order: new Uint8Array(orderCapacity * PRIMITIVE_STRIDES.order),
    frame: new Uint8Array(PRIMITIVE_STRIDES.frame),
  };
}

function createIncarnations(): Record<PrimitiveResourceId, symbol> {
  return {
    transforms: Symbol('transforms-incarnation'),
    geometry: Symbol('geometry-incarnation'),
    styles: Symbol('styles-incarnation'),
    order: Symbol('order-incarnation'),
    frame: Symbol('frame-incarnation'),
  };
}

function createVersions(): VersionedRecords {
  return { transforms: [], geometry: [], styles: [], order: [], frame: [] };
}

function dirtyIndices(versions: readonly (symbol | undefined)[]): number[] {
  return versions.flatMap((version, index) => (version === undefined ? [] : [index]));
}

function contiguousRanges(indices: readonly number[]) {
  const ranges: Array<{ first: number; last: number }> = [];
  for (const index of indices) {
    const last = ranges.at(-1);
    if (last !== undefined && last.last + 1 === index) last.last = index;
    else ranges.push({ first: index, last: index });
  }
  return ranges;
}

function expectedRecords(writes: readonly PrimitiveWrite[]) {
  const expected = new Map<PrimitiveResourceId, Map<number, symbol>>();
  for (const write of writes) {
    let records = expected.get(write.resourceId);
    if (records === undefined) {
      records = new Map<number, symbol>();
      expected.set(write.resourceId, records);
    }
    for (const record of write.records) records.set(record.index, record.version);
  }
  return expected;
}

function validateReceiptResources(
  receipt: PrimitiveReceipt,
  expected: ReadonlyMap<PrimitiveResourceId, ReadonlyMap<number, symbol>>,
  incarnations: Readonly<Record<PrimitiveResourceId, symbol>>,
): ReadonlyMap<PrimitiveResourceId, readonly PrimitiveRecordVersion[]> | null {
  if (receipt.resources.length !== RESOURCE_ORDER.length) return null;
  const result = new Map<PrimitiveResourceId, readonly PrimitiveRecordVersion[]>();
  for (let resourceIndex = 0; resourceIndex < receipt.resources.length; resourceIndex += 1) {
    const resource = receipt.resources[resourceIndex]!;
    if (
      resource.resourceId !== RESOURCE_ORDER[resourceIndex] ||
      result.has(resource.resourceId) ||
      resource.incarnation !== incarnations[resource.resourceId]
    ) {
      return null;
    }
    const expectedRecordsForResource = expected.get(resource.resourceId);
    if (resource.records.length !== (expectedRecordsForResource?.size ?? 0)) {
      return null;
    }
    const indices = new Set<number>();
    for (const record of resource.records) {
      if (
        indices.has(record.index) ||
        !expectedRecordsForResource?.has(record.index) ||
        expectedRecordsForResource?.get(record.index) !== record.version
      )
        return null;
      indices.add(record.index);
    }
    result.set(resource.resourceId, resource.records);
  }
  return result;
}

function receiptMatchesPacket(receipt: PrimitiveReceipt, packet: PrimitivePacket): boolean {
  return (
    receipt.packetId === packet.packetId &&
    receipt.sceneEpoch === packet.sceneEpoch &&
    receipt.scene.identity.documentId === packet.scene.identity.documentId &&
    receipt.scene.identity.pageId === packet.scene.identity.pageId &&
    receipt.scene.revision === packet.scene.revision &&
    receipt.cameraRevision === packet.cameraRevision &&
    receipt.surfaceRevision === packet.surfaceRevision &&
    receipt.originRevision === packet.originRevision &&
    receipt.generation === packet.generation &&
    Number.isSafeInteger(receipt.submissionSerial) &&
    receipt.submissionSerial >= 0
  );
}

function numericArraysEqual(
  left: readonly number[] | null | undefined,
  right: readonly number[],
): boolean {
  return (
    left !== null &&
    left !== undefined &&
    left.length === right.length &&
    left.every((value, index) => Object.is(value, right[index]))
  );
}

function highWater(values: readonly (string | undefined)[]): number {
  for (let index = values.length - 1; index >= 0; index -= 1)
    if (values[index] !== undefined) return index + 1;
  return 0;
}

function copyVersion(version: SceneVersion): SceneVersion {
  return Object.freeze({
    identity: Object.freeze({
      documentId: version.identity.documentId,
      pageId: version.identity.pageId,
    }),
    revision: version.revision,
  });
}

function compareOrdinal(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function validateTarget(target: PrimitiveTarget): void {
  if (
    !Number.isSafeInteger(target.generation) ||
    target.generation < 0 ||
    !Number.isSafeInteger(target.surfaceRevision) ||
    target.surfaceRevision < 0 ||
    !Number.isSafeInteger(target.width) ||
    target.width <= 0 ||
    !Number.isSafeInteger(target.height) ||
    target.height <= 0 ||
    !Number.isFinite(target.devicePixelRatio) ||
    target.devicePixelRatio <= 0 ||
    (target.sampleCount !== 1 && target.sampleCount !== 4) ||
    (target.targetFormat !== 'bgra8unorm' && target.targetFormat !== 'rgba8unorm')
  )
    throw new RangeError('Invalid primitive target.');
}

/** E10 contract, section 3.1: one entry per packet mesh draw, which follows pathDraws in order. */
function drawRecord(
  prepareSerial: number,
  pathDraws: readonly PathMeshDraw[],
  meshDraws: readonly MeshFillDraw[],
  hasFringeBuilder: boolean,
): PathDrawRecordForTesting {
  const draws = meshDraws.map((meshDraw, index): PathDrawRecordEntryForTesting => {
    const draw = pathDraws[index]!;
    const joint = meshDraw.composite === 'joint-fill';
    // A joint fill draw reports its fill paint's fringe state.
    const fringe = draw.fringe?.data ?? null;
    return Object.freeze({
      nodeId: draw.nodeId,
      paint: draw.paint ?? 'fill',
      composite: joint ? 'joint-fill' : 'plain',
      fringe: fringe !== null ? 'built' : hasFringeBuilder ? 'region-only-cap' : 'region-only-off',
      triangleCount: meshDraw.triangleCount,
      regionTriangles: joint ? null : (fringe?.regionTriangles ?? meshDraw.triangleCount),
      exteriorTriangles: joint ? null : (fringe?.exteriorTriangles ?? 0),
    });
  });
  return Object.freeze({ prepareSerial, draws: Object.freeze(draws) });
}
