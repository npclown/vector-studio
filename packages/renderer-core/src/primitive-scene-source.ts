import { isSceneGradient } from '@vector-studio/contracts';
import type {
  GlyphRasterPort,
  RenderNodeSnapshot,
  SceneAffine,
  SceneBlendMode,
  SceneVersion,
} from '@vector-studio/contracts';
import type {
  ClipMaskPacketLevel,
  MeshFillDraw,
  MeshPacketPart,
  LayerEffectRecord,
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
  TextDraw,
  TextPacketPart,
} from './primitive-packet.js';
import {
  PRIMITIVE_STRIDES,
  PrimitiveNumericPreparationError,
  assessPrimitivePacking,
  primitivePackingBoundOver,
  primitivePackingWithinBudget,
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
import { disablePathReuseForTesting } from './path-mesh-pipeline.js';
import {
  decisionRange,
  intersectRanges,
  pointRange,
  rangeHolds,
  type CameraRange,
} from './camera-range.js';
import {
  PathMeshPacker,
  meshFrameLanes,
  selectMeshOrigin,
  type MeshExpectedRecords,
  type MeshOrigin,
} from './path-mesh-packet.js';
import { GradientRecordTable, paintColorLanes, type GradientPaintRecord } from './paint-records.js';
import type { RetainedSceneMirror, RetainedSceneView } from './scene-mirror.js';
import {
  ClipStateTable,
  MaskLevelMemo,
  MaskPlan,
  extendClipChain,
  meetsClipChain,
  rebaseClipChain,
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
  GlyphAtlasPlan,
  getTextLocalBounds,
  planTextFrame,
  repeatTextFrame,
  type AtlasFrame,
  type TextFrame,
} from './text-atlas.js';
import { planEffectLayers, type EffectLayer } from './effect-layers.js';
import { asksForBlendLayer, planBlendLayers, type BlendResourceNotice } from './backdrop-plan.js';
import {
  E41_LAYER_REACH_MAX,
  cullTarget,
  extendEffectReach,
  type EffectBudgetNotice,
  type EffectReach,
} from './effect-plan.js';
import {
  layerBound,
  planLayerBudget,
  type DeviceRect,
  type BlendRootMode,
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
  /** E41-K3: the reach of the effect roots above it; culling tests its grown bound. */
  reach?: EffectReach;
}>;
type MaskSource = Readonly<{ source: MaskSourceRecord; key: string }>;
type MaskSourceMemo = Readonly<{ inputs: readonly unknown[]; result: MaskSource }>;
/** E28 contract, U2: a text leaf of the traversal. */
type DerivedText = Readonly<{
  id: string;
  node: Extract<RenderNodeSnapshot, { kind: 'text' }>;
  world: SceneAffine;
  /** E28-K9, in world units; null without a cluster. */
  worldBounds: SceneBounds | null;
  hidden: boolean;
  clip: ClipChain | null;
  sequence: number;
  layer: LayerScope | null;
  /** E41-K3, as a primitive's. */
  reach?: EffectReach;
}>;
type DerivedTexts = { leaves: DerivedText[]; held: boolean };
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
  meshExpected: MeshExpectedRecords | null;
  /** E28: the atlas frame the packet's text part carries; null without a text part. */
  text: AtlasFrame | null;
}>;
type PackingKeys = Readonly<{
  /** The derived primitive the keys were taken from (E26-U5c). */
  primitive: DerivedPrimitive;
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
const NO_EFFECT_STATISTICS = Object.freeze({ roots: 0, clampedSigmas: 0 });
const LAYER_NOTICES_PER_PACKET = 32;
const IDENTITY: SceneAffine = [1, 0, 0, 1, 0, 0];
/** P1 contract (position error): the packet v1 budget, in physical pixels, on both measures. */
const PACKING_BUDGET_PX = 0.125;
/** E30-U3b: the packing range's zoom ratio (zoom within a factor 1 + 1/16 of the camera's). */
const PACKING_RANGE_ZOOM = 1 / 16;

type DerivationCounts = Readonly<{
  /** Frames that kept the derivation unchanged. */
  reused: number;
  /** Frames that re-derived only the written leaves. */
  patched: number;
  /** Frames that derived the whole scene. */
  full: number;
  /** Nodes derived in patched and full frames together. */
  leaves: number;
}>;

type PackingCounts = Readonly<{
  /** Camera ranges the packing bound was taken over (E30-U3b). */
  ranges: number;
  /** Primitive checks the range bound decided, skipping the per-camera check. */
  ranged: number;
  /** Primitive checks that ran at the camera (the U5d bound, then the assessment). */
  perCamera: number;
  /**
   * E30-U3b: frames that kept the cull, frames that culled, and cull ranges taken; E30-U4b:
   * frames that decided only the leaves a set replaced.
   */
  cull: Readonly<{ kept: number; culls: number; ranges: number; patched: number }>;
  /** E30-U4b: frames that kept the last mask plan, and frames that planned afresh. */
  masks: Readonly<{ kept: number; planned: number }>;
  /** E30-U4c: text frames that repeated the last atlas frame, and frames that planned it. */
  text: Readonly<{ repeated: number; planned: number }>;
}>;

type PackingRange = Readonly<{
  key: readonly number[];
  range: CameraRange;
  passed: WeakSet<DerivedPrimitive>;
  declined: WeakSet<DerivedPrimitive>;
}>;

let injectFullDerivation: (source: PrimitiveSceneSource) => void;
let readDerivationCounts: (source: PrimitiveSceneSource) => DerivationCounts;
let readPackingCounts: (source: PrimitiveSceneSource) => PackingCounts;

/**
 * Test seam (E26-U5c): prepare as before U5c, the oracle of its kept state: derive the whole
 * scene and reconcile every slot on every frame, assess every primitive against the packing
 * budget and compare every primitive's packing keys. Not exported from the package index.
 */
export function useFullDerivationForTesting(source: PrimitiveSceneSource): void {
  injectFullDerivation(source);
}

/** Test seam (E26-U5c): how this source derived its frames. Not exported from the package index. */
export function derivationCountsForTesting(source: PrimitiveSceneSource): DerivationCounts {
  return readDerivationCounts(source);
}

/** Test seam (E30-U3b): how this source checked the packing budget. Not exported from the index. */
export function packingCountsForTesting(source: PrimitiveSceneSource): PackingCounts {
  return readPackingCounts(source);
}

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
  /** E26 contract, U5c: the kept derivation, and the change serial the slots are current at. */
  #derivation: Derivation | null = null;
  #slotSerial: number | null = null;
  #fullDerivation = false;
  #derivationCounts = { reused: 0, patched: 0, full: 0, leaves: 0 };
  #culled: KeptCull | null = null;
  /** E30-U4b: the last mask plan with its inputs, all of its content admitted. */
  #keptMaskPlan: Readonly<{ inputs: readonly unknown[]; plan: MaskPlan }> | null = null;
  #effectClips: Readonly<{ roots: readonly LayerScope[]; clips: EffectClips | null }> | null = null;
  #maskPlanCounts = { kept: 0, planned: 0 };
  #textFrameCounts = { repeated: 0, planned: 0 };
  /** E30-U4b: each derived path's layer content bounds (`#pathContentBounds`). */
  #contentBounds = new WeakMap<
    DerivedPath,
    Readonly<{ fill: SceneBounds | null; stroke: SceneBounds | null }>
  >();
  #cullCounts = { kept: 0, ranges: 0, culls: 0, patched: 0 };
  /**
   * E30-U3b: camera-independent per-frame results kept by the identity of their inputs: the
   * layers' content bounds, the mask plan's paint-order content, and the arrays a frame filters
   * (the same items keep the kept array, so the passes keyed by it keep their work).
   */
  #layerContent: Readonly<{
    inputs: readonly unknown[];
    content: ReadonlyMap<LayerScope, readonly SceneBounds[]>;
  }> | null = null;
  #maskContent: Readonly<{
    inputs: readonly unknown[];
    content: readonly Readonly<{ sequence: number; chain: ClipChain | null }>[];
  }> | null = null;
  #interned = new Map<string, readonly unknown[]>();
  #meshPartDraws = new WeakMap<
    PathMeshDraw,
    Readonly<{ sequence: number; draw: Omit<MeshFillDraw, 'position'> }>
  >();
  #meshFillDraws: readonly Readonly<{
    source: object;
    position: number;
    clipState: number;
    gradient: number;
    strokeGradient: number;
    draw: MeshFillDraw;
  }>[] = [];
  #pathMaps = new WeakMap<readonly DerivedPath[], ReadonlyMap<string, DerivedPath>>();
  #pathClipMaps = new WeakMap<readonly DerivedPath[], ReadonlyMap<string, ClipChain | null>>();
  /** The inputs the primitives in `#assessed` passed the packing budget under. */
  #assessedKey: readonly number[] | null = null;
  #assessed = new WeakSet<DerivedPrimitive>();
  /**
   * E30 contract, U3b: a camera range around a recent camera, under fixed packing inputs (DPR,
   * target, origin), and the primitives whose packing bound over the whole range is within the
   * budget (`passed`) or not (`declined`, checked at each camera as before).
   */
  #packingRange: PackingRange | null = null;
  #packingCounts = { ranges: 0, ranged: 0, perCamera: 0 };

  static {
    injectFullDerivation = (source) => {
      source.#fullDerivation = true;
      source.#clipStates.disableReuseForTesting();
      if (source.#pathMeshes !== undefined) disablePathReuseForTesting(source.#pathMeshes);
    };
    readDerivationCounts = (source) => Object.freeze({ ...source.#derivationCounts });
    readPackingCounts = (source) =>
      Object.freeze({
        ...source.#packingCounts,
        cull: Object.freeze({ ...source.#cullCounts }),
        masks: Object.freeze({ ...source.#maskPlanCounts }),
        text: Object.freeze({ ...source.#textFrameCounts }),
      });
  }
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
  /** E26 contract, U5d-2: the mask plan's kept level records and source results. */
  readonly #maskLevels = new MaskLevelMemo();
  #maskSources = new Map<string, MaskSourceMemo>();
  #primitiveMaps = new WeakMap<
    readonly DerivedPrimitive[],
    ReadonlyMap<string, DerivedPrimitive>
  >();
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
  /** E41-S8: the effect budget's notices, queued as the layer notices are. */
  #effectsOverBudget = new Set<string>();
  #effectNotices: EffectBudgetNotice[] = [];
  #effectNoticesDropped = 0;
  /** V35-K6: the blend notices, queued as the effect notices are. */
  #blendOverBudget = new Set<string>();
  #blendNotices: BlendResourceNotice[] = [];
  #blendNoticesDropped = 0;
  #effectStatistics: Readonly<{ roots: number; clampedSigmas: number }> = NO_EFFECT_STATISTICS;
  /** E41-K2 and section 5.4: the device's `maxTextureDimension2D`. */
  readonly #maxTextureDimension: number;
  /** @internal Tests only (E25-A05): every visible container with opacity 1 is a layer too. */
  readonly #isolateUnitOpacity: boolean;
  /** E28 contract, U2: the glyph atlas plan; null without `text: 'atlas'`. */
  readonly #atlas: GlyphAtlasPlan | null;
  /** V-21 (section 4.3): the scene's text generations, kept while the derived set is unchanged. */
  #generations: Readonly<{ texts: DerivedTexts; set: ReadonlySet<number> }> | null = null;
  /**
   * E30-U4c: the last text frame and what it was planned from: the drawn leaves, whether the
   * scene holds text, the camera, and the target's generation, size and DPR.
   */
  #keptText: Readonly<{
    texts: readonly DerivedText[];
    held: boolean;
    key: readonly number[];
    frame: TextFrame;
  }> | null = null;
  readonly #onTextDeferred: (() => void) | undefined;
  /** P3 V3 section f: true exactly when this source consumes a fill-mesh or stroke-mesh port. */
  public readonly requiresMeshPipeline: boolean;

  public constructor(
    mirror: RetainedSceneMirror,
    pathMeshes?: PathMeshPipeline,
    options: Readonly<{
      isolateUnitOpacityForTesting?: boolean;
      /** E41 section 5.4: the device's `maxTextureDimension2D`; default 8192. */
      maxTextureDimension2D?: number;
      /**
       * E28 contract, U2: the glyph raster port and the atlas size, and the callback the service
       * invalidates through when a packet with deferred clusters is acknowledged.
       */
      text?: Readonly<{
        port: GlyphRasterPort;
        pages?: number;
        pageSize?: number;
        onDeferred?: () => void;
      }>;
    }> = {},
  ) {
    this.#isolateUnitOpacity = options.isolateUnitOpacityForTesting === true;
    this.#maxTextureDimension = options.maxTextureDimension2D ?? 8192;
    const text = options.text;
    this.#atlas =
      text === undefined
        ? null
        : new GlyphAtlasPlan(text.port, {
            ...(text.pages === undefined ? {} : { pages: text.pages }),
            ...(text.pageSize === undefined ? {} : { pageSize: text.pageSize }),
          });
    this.#onTextDeferred = text?.onDeferred;
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

    // E28 section 4, Lifetime: a packet replaced without acknowledgement may have written to
    // the atlas pages it cleared or uploaded to.
    const stale = this.#pending;
    if (stale !== null && stale.text !== null && this.#atlas !== null) {
      this.#atlas.replaced(stale.text);
      this.#pending = null;
    }

    const epochChanged = scene.sceneEpoch !== this.#sceneEpoch;
    if (epochChanged) this.#resetForSnapshot(scene);
    else
      this.#reconcileSlots(
        scene,
        this.#slotSerial === null || this.#fullDerivation
          ? null
          : scene.changedSince(this.#slotSerial),
      );
    this.#slotSerial = scene.changeSerial;

    const derivation = this.#derive(scene);
    const derived = derivation.primitives;
    const paths = derivation.paths;
    const pathSequences = derivation.pathSequences;
    const clipSeen = { value: derivation.clipSeen };
    const layerScopes = derivation.layerScopes;
    const pathLayers = derivation.pathLayers;
    const derivedTexts = derivation.texts;
    const culled = this.#cull(derivation, cameraState.camera, target);
    let visible = culled.visible;
    let texts = culled.texts;
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
        texts,
        pathDraws,
        this.#pathsById(paths),
        pathLayers,
        cameraState.camera,
        target,
      );
      const plan = layerPlan;
      const inDrawn = (layer: LayerScope | null | undefined) => plan.contains(layer);
      visible = this.#intern(
        'layer-visible',
        visible.filter((primitive) => inDrawn(primitive.layer)),
      );
      texts = this.#intern(
        'layer-texts',
        texts.filter((text) => inDrawn(text.layer)),
      );
      pathDraws = this.#intern(
        'layer-paths',
        pathDraws.filter(
          (draw) => draw.maskSource === true || inDrawn(pathLayers.get(draw.nodeId)),
        ),
      );
    } else {
      if (this.#layersOverBudget.size > 0) this.#layersOverBudget = new Set();
      if (this.#effectsOverBudget.size > 0) this.#effectsOverBudget = new Set();
      if (this.#blendOverBudget.size > 0) this.#blendOverBudget = new Set();
      this.#effectStatistics = NO_EFFECT_STATISTICS;
    }
    // P4 contract, U4: mask levels are planned over the drawn content in paint order; content
    // under an undrawable level (empty bound, a source covering nothing, over the budget) is
    // not drawn, and mask source draws never paint.
    let masks: MaskPlan | null = null;
    // U4: the primitive mask sources are packed and drawn by their slots, so they join the
    // visible primitives in the origin choice and the packing budget.
    let assessed = visible;
    const pathClips = this.#pathClips(paths);
    // E41-K2b: inside a drawn effect root, a draw's chain is rebased at the innermost root; the
    // root's composite carries its ancestors' chain, rebased at the root around it. Only for a
    // backend that draws the effect passes (and so the composite's clip variant); otherwise a
    // root composites as an E25 layer of its content (5.3), with the chains as they are.
    const effectClips =
      clipSeen.value && target.offTargetEffectLayers === true
        ? this.#effectClipsOf(layerPlan)
        : null;
    if (clipSeen.value) {
      const content = this.#maskContentOf(
        visible,
        pathDraws,
        texts,
        pathSequences,
        pathClips,
        pathLayers,
        effectClips,
      );
      // E30-U4b: a frame with the kept plan's inputs (the same derivation, path draws, content,
      // camera and target) keeps the plan, whose levels and admissions are then the same.
      const camera = cameraState.camera;
      const inputs = [
        derived,
        derivation.paths,
        pathDraws,
        content,
        camera.position.x,
        camera.position.y,
        camera.zoom,
        target.width,
        target.height,
        target.devicePixelRatio,
        target.sampleCount,
      ];
      const keptPlan = this.#keptMaskPlan;
      if (
        !this.#fullDerivation &&
        keptPlan !== null &&
        keptPlan.inputs.every((input, index) => Object.is(input, inputs[index]))
      ) {
        masks = keptPlan.plan;
        this.#maskPlanCounts.kept += 1;
      } else {
        masks = this.#planMasks(scene, derived, pathDraws, camera, target);
        // E41-K2b: a root's composite chain is planned before the content under it, which is
        // drawn only when every root around it is.
        for (const chain of effectClips?.composites.values() ?? []) masks.admit(chain);
        for (const entry of content) masks.admit(entry.chain);
        this.#maskPlanCounts.planned += 1;
        if (!this.#fullDerivation) this.#keptMaskPlan = Object.freeze({ inputs, plan: masks });
      }
      const plan = masks;
      const admit = (chain: ClipChain | null, layer: LayerScope | null | undefined) =>
        effectClips === null
          ? plan.admit(chain)
          : plan.admit(effectClips.chainOf(chain, layer)) && effectClips.rootsAdmitted(plan, layer);
      visible = this.#intern(
        'mask-visible',
        visible.filter((primitive) => admit(primitive.clip, primitive.layer)),
      );
      texts = this.#intern(
        'mask-texts',
        texts.filter((text) => admit(text.clip, text.layer)),
      );
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
      pathDraws = this.#intern(
        'mask-paths',
        pathDraws.filter((draw) =>
          draw.maskSource === true
            ? used.has(draw.nodeId)
            : admit(pathClips.get(draw.nodeId) ?? null, pathLayers.get(draw.nodeId)),
        ),
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
      const pathById = this.#pathsById(paths);
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
    // E28 contract, U2: the atlas plan over the drawn text leaves, in paint order; each leaf's
    // draws are items at its sequence, merged with the mesh draws.
    const textFrame =
      this.#atlas === null
        ? null
        : this.#textFrame(texts, derivedTexts, cameraState.camera, target);
    const textItems =
      textFrame === null
        ? []
        : texts.flatMap((text, leaf) => textFrame.draws[leaf]!.map((draw) => ({ text, draw })));
    const items = mergeItems(
      mesh?.draws.map((draw) => draw.sequence) ?? [],
      textItems.map((item) => item.text.sequence),
    );
    // P4 contract, U2: clip states are numbered in drawn paint order; a state change splits an
    // analytic run. An unclipped frame has no states and the P3 draws, unchanged.
    let clip: ClipStates = NO_CLIP_STATES;
    if (clipSeen.value) {
      // The mesh part's draws are the content path draws, in the same order.
      const chainOf = (chain: ClipChain | null, layer: LayerScope | null | undefined) =>
        effectClips === null ? chain : effectClips.chainOf(chain, layer);
      clip = this.#assignClipStates(
        visible,
        items.map((item) => {
          if (item.kind === 'mesh') {
            const nodeId = contentPathDraws[item.index]!.nodeId;
            return {
              sequence: item.sequence,
              clip: chainOf(pathClips.get(nodeId) ?? null, pathLayers.get(nodeId)),
            };
          }
          const text = textItems[item.index]!.text;
          return { sequence: item.sequence, clip: chainOf(text.clip, text.layer) };
        }),
        effectClips === null ? null : (primitive) => chainOf(primitive.clip, primitive.layer),
        // A root under a level that is not drawn has no content; its composite is unclipped.
        effectClips === null
          ? []
          : [...effectClips.composites].map(([root, chain]) =>
              effectClips.rootsAdmitted(masks!, root) ? chain : null,
            ),
      );
    } else if (this.#clipStatesUsed) {
      // Releases the previous frame's states once the scene has no clip left; a mask that
      // returns over budget is reported again.
      this.#clipStates.begin();
      this.#clipStates.end();
      this.#overBudget = new Set();
    }
    this.#clipStatesUsed = clipSeen.value;
    const meshStates: number[] = [];
    const textStates: number[] = [];
    items.forEach((item, index) => {
      (item.kind === 'mesh' ? meshStates : textStates)[item.index] = clip.meshStates[index] ?? 0;
    });
    const itemTargets =
      layerPlan === null || layerPlan.order.length === 0
        ? null
        : items.map((item) =>
            layerPlan.indexOf(
              item.kind === 'mesh'
                ? pathLayers.get(contentPathDraws[item.index]!.nodeId)
                : textItems[item.index]!.text.layer,
            ),
          );
    const layered =
      itemTargets === null
        ? null
        : interleaveLayerDraws(
            visible,
            visible.map((primitive) => layerPlan!.indexOf(primitive.layer)),
            items.map((item) => item.sequence),
            itemTargets,
            layerPlan!.order.map((layer, index) => ({
              layer: index,
              target: layerPlan!.indexOf(layer.parent),
              sequence: layer.start,
              depth: layer.depth,
            })),
            clip.primitiveStates,
            primitivePaints.length === 0 ? [] : paintFlags,
            layerPlan!.order.length,
          );
    const flat =
      layered === null
        ? interleaveDraws(
            visible,
            items.map((item) => item.sequence),
            clip.primitiveStates,
            primitivePaints.length === 0 ? [] : paintFlags,
          )
        : null;
    const draws = layered?.main ?? flat!.analytic;
    const itemPositions = layered?.positions ?? flat!.positions;
    const itemOrders = layered?.orders ?? flatOrders(flat!.positions);
    const meshPositions: number[] = [];
    const textPlacements: { position: number; order: number; target: number }[] = [];
    items.forEach((item, index) => {
      if (item.kind === 'mesh') meshPositions[item.index] = itemPositions[index]!;
      else {
        textPlacements[item.index] = {
          position: itemPositions[index]!,
          order: itemOrders[index]!,
          target: itemTargets?.[index] ?? -1,
        };
      }
    });
    // E30-U3b: a mesh draw whose inputs are the kept draw's keeps the kept draw object.
    const keptMeshDraws = this.#fullDerivation ? [] : this.#meshFillDraws;
    const meshFillDraws = (mesh?.draws ?? []).map((draw, index) => {
      const position = meshPositions[index]!;
      const clipState = meshStates[index] ?? 0;
      const gradient = meshGradients[index]!;
      const strokeGradient = strokeGradients[index]!;
      const kept = keptMeshDraws[index];
      if (
        kept !== undefined &&
        kept.source === draw.draw &&
        kept.position === position &&
        kept.clipState === clipState &&
        kept.gradient === gradient &&
        kept.strokeGradient === strokeGradient
      ) {
        return kept.draw;
      }
      return Object.freeze<MeshFillDraw>({
        position,
        ...draw.draw,
        ...(clipState === 0 ? {} : { clipState }),
        ...(gradient === 0 ? {} : { gradient }),
        ...(strokeGradient === 0 ? {} : { strokeGradient }),
      });
    });
    if (!this.#fullDerivation) {
      this.#meshFillDraws = meshFillDraws.map((draw, index) => ({
        source: mesh!.draws[index]!.draw,
        position: meshPositions[index]!,
        clipState: meshStates[index] ?? 0,
        gradient: meshGradients[index]!,
        strokeGradient: strokeGradients[index]!,
        draw,
      }));
    }
    const meshTargets =
      layered === null
        ? null
        : contentPathDraws.map((draw) => layerPlan!.indexOf(pathLayers.get(draw.nodeId)));
    const mainMeshDraws =
      meshTargets === null
        ? meshFillDraws
        : meshFillDraws.filter((_, index) => meshTargets[index] === -1);
    // Each layer's mesh draws, in one pass over the draws.
    const meshByLayer = new Map<number, (typeof meshFillDraws)[number][]>();
    if (meshTargets !== null) {
      meshFillDraws.forEach((draw, index) => {
        const layer = meshTargets[index]!;
        if (layer === -1) return;
        const list = meshByLayer.get(layer);
        if (list === undefined) meshByLayer.set(layer, [draw]);
        else list.push(draw);
      });
    }
    const layerNotices = this.#layerNotices.slice(0, LAYER_NOTICES_PER_PACKET);
    const effectNotices = this.#effectNotices.slice(0, LAYER_NOTICES_PER_PACKET);
    const blendNotices = this.#blendNotices.slice(0, LAYER_NOTICES_PER_PACKET);
    const layersPart: LayerPacketPart | null =
      layered === null &&
      layerNotices.length === 0 &&
      effectNotices.length === 0 &&
      blendNotices.length === 0
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
                  meshDraws: Object.freeze(meshByLayer.get(index) ?? []),
                  ...effectRecordOf(layerPlan!.effects.get(layer)),
                  ...blendRecordOf(layerPlan!.blends.get(layer), layer),
                }),
              ),
            ),
            composites: Object.freeze(
              compositeClipStates(layered?.composites ?? [], layerPlan, effectClips, clip),
            ),
            notices: Object.freeze(layerNotices),
            ...(effectNotices.length === 0 ? {} : { effectNotices: Object.freeze(effectNotices) }),
            ...(blendNotices.length === 0 ? {} : { blendNotices: Object.freeze(blendNotices) }),
          });
    // E28 contract, section 4: the text part; present while text is drawn, the atlas holds or
    // releases pages, a notice is pending or clusters are deferred (whose acknowledgement
    // invalidates).
    const textNotices = this.#atlas?.peekNotices() ?? [];
    const atlasFrame = textFrame?.atlas ?? null;
    const textDraws: TextDraw[] = textItems.map((item, index) => {
      const placement = textPlacements[index]!;
      return Object.freeze({
        first: item.draw.first,
        count: item.draw.count,
        page: item.draw.page,
        target: placement.target,
        position: placement.position,
        order: placement.order,
        ...((textStates[index] ?? 0) === 0 ? {} : { clipState: textStates[index]! }),
      });
    });
    const textPart: TextPacketPart | null =
      atlasFrame === null ||
      (textDraws.length === 0 &&
        textNotices.length === 0 &&
        atlasFrame.deferred === 0 &&
        atlasFrame.pageCount === 0 &&
        this.#atlas!.committedPageCount === 0)
        ? null
        : Object.freeze({
            layoutVersion: 0 as const,
            pageSize: this.#atlas!.pageSize,
            pageCount: atlasFrame.pageCount,
            clears: atlasFrame.clears,
            uploads: atlasFrame.uploads,
            instances: textFrame!.instances,
            draws: Object.freeze(textDraws),
            notices: Object.freeze(textNotices),
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
      draws: Object.freeze(draws),
      frame: Object.freeze({ ...target }),
      ...(this.#maskNotices.length === 0
        ? {}
        : { clipNotices: Object.freeze(this.#maskNotices.slice(0, MASK_NOTICES_PER_PACKET)) }),
      ...(layersPart === null ? {} : { layers: layersPart }),
      ...(textPart === null ? {} : { text: textPart }),
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
    this.#effectNotices.splice(0, packet.layers?.effectNotices?.length ?? 0);
    this.#blendNotices.splice(0, packet.layers?.blendNotices?.length ?? 0);
    this.#atlas?.consumeNotices(textPart?.notices.length ?? 0);
    this.#pending = Object.freeze({
      packet,
      expected: expectedRecords(writes),
      meshExpected: mesh?.expected ?? null,
      text: textPart === null ? null : atlasFrame,
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
    const reuse = !this.#fullDerivation;
    let primitives = reuse ? this.#primitiveMaps.get(derived) : undefined;
    if (primitives === undefined) {
      primitives = new Map(derived.map((primitive) => [primitive.id, primitive] as const));
      if (reuse) this.#primitiveMaps.set(derived, primitives);
    }
    const byId = primitives;
    const sources = new Map(
      pathDraws.flatMap((draw) => (draw.maskSource === true ? [[draw.nodeId, draw] as const] : [])),
    );
    // E26 contract, U5d-2: a level's source result is kept while every input of its key and its
    // record is the same, so an unchanged level keeps its record (MaskLevelMemo).
    const kept = this.#maskSources;
    const next = new Map<string, MaskSourceMemo>();
    this.#maskSources = next;
    const remember = (sourceId: string, inputs: readonly unknown[], build: () => MaskSource) => {
      const previous = reuse ? (next.get(sourceId) ?? kept.get(sourceId)) : undefined;
      if (
        previous !== undefined &&
        previous.inputs.length === inputs.length &&
        previous.inputs.every((input, index) => Object.is(input, inputs[index]))
      ) {
        next.set(sourceId, previous);
        return previous.result;
      }
      const result = build();
      if (reuse) next.set(sourceId, Object.freeze({ inputs, result }));
      return result;
    };
    const sourceOf = (level: ClipMaskLevel): MaskSource | null => {
      if (level.sourceId === null) return null;
      const primitive = byId.get(level.sourceId);
      if (primitive !== undefined) {
        if (primitive.omitted || primitive.node.geometry.kind === 'line') return null;
        return remember(
          level.sourceId,
          ['primitive', primitive.slot, primitive.node.geometry, primitive.world],
          () => ({
            source: Object.freeze({ kind: 'primitive', slot: primitive.slot }),
            key: JSON.stringify(['primitive', primitive.node.geometry, primitive.world]),
          }),
        );
      }
      const draw = sources.get(level.sourceId);
      const node = scene.getNode(level.sourceId);
      if (draw === undefined || node?.kind !== 'path') return null;
      const revision = scene.getGeometryRevision(level.sourceId) ?? 0;
      return remember(
        level.sourceId,
        [
          'mesh',
          revision,
          node.geometry.fillRule,
          level.world,
          node.transform,
          draw.toleranceExponent,
          draw.fringeBucket,
        ],
        () => ({
          source: Object.freeze({ kind: 'mesh', nodeId: level.sourceId! }),
          key: JSON.stringify([
            'mesh',
            revision,
            node.geometry.fillRule,
            composeSceneAffine(level.world, node.transform),
            draw.toleranceExponent,
            draw.fringeBucket,
          ]),
        }),
      );
    };
    return new MaskPlan({
      sourceOf,
      ...(reuse ? { memo: this.#maskLevels } : {}),
      camera: { x: camera.position.x, y: camera.position.y, zoom: camera.zoom },
      target,
    });
  }

  /** E25-K5: the world bounds of each layer's drawn content (camera-independent). */
  #layerContentOf(
    visible: readonly DerivedPrimitive[],
    texts: readonly DerivedText[],
    pathDraws: readonly PathMeshDraw[],
    paths: ReadonlyMap<string, DerivedPath>,
    pathLayers: ReadonlyMap<string, LayerScope>,
  ): ReadonlyMap<LayerScope, readonly SceneBounds[]> {
    const content = new Map<LayerScope, SceneBounds[]>();
    const add = (layer: LayerScope | null | undefined, bounds: SceneBounds | null) => {
      if (layer === null || layer === undefined || bounds === null) return;
      const list = content.get(layer);
      if (list === undefined) content.set(layer, [bounds]);
      else list.push(bounds);
    };
    for (const primitive of visible) add(primitive.layer, primitive.worldBounds);
    // E28-K9: a text leaf's bound joins its layer as a leaf's does.
    for (const text of texts) add(text.layer, text.worldBounds);
    for (const draw of pathDraws) {
      if (draw.maskSource === true) continue;
      const layer = pathLayers.get(draw.nodeId);
      if (layer === undefined) continue;
      const bounds = this.#pathContentBounds(paths.get(draw.nodeId)!);
      if (draw.paint !== 'stroke') add(layer, bounds.fill);
      // A joint fill draw also covers its stroke (ST-U7 addendum).
      if (draw.paint === 'stroke' || draw.composite === 'joint-fill') add(layer, bounds.stroke);
    }
    return content;
  }

  /**
   * A derived path's fill and stroke world bounds for layer content; E30-U4b: kept per derived
   * path object, which a set replaces whenever it writes the path.
   */
  #pathContentBounds(
    path: DerivedPath,
  ): Readonly<{ fill: SceneBounds | null; stroke: SceneBounds | null }> {
    const kept = this.#fullDerivation ? undefined : this.#contentBounds.get(path);
    if (kept !== undefined) return kept;
    const points = path.node.geometry.points;
    const fill = getPathLocalPointBounds(points);
    const stroke = getPathLocalStrokeBounds(points, path.node.style.stroke);
    const bounds = Object.freeze({
      fill: fill === null ? null : transformSceneBounds(fill, path.world),
      stroke: stroke === null ? null : transformSceneBounds(stroke, path.world),
    });
    if (!this.#fullDerivation) this.#contentBounds.set(path, bounds);
    return bounds;
  }

  /**
   * E25 contract, section 4: the frame's drawn layers. Bounds (E25-K5) are built bottom-up over
   * the drawn content, then clamped top-down to the parent's bound; a layer with an empty bound,
   * or inside one, is not drawn. Layer trees then pass the budget in paint order.
   */
  #planLayers(
    scopes: readonly LayerScope[],
    visible: readonly DerivedPrimitive[],
    texts: readonly DerivedText[],
    pathDraws: readonly PathMeshDraw[],
    paths: ReadonlyMap<string, DerivedPath>,
    pathLayers: ReadonlyMap<string, LayerScope>,
    camera: Readonly<{ position: Readonly<{ x: number; y: number }>; zoom: number }>,
    target: PrimitiveTarget,
  ): DrawnLayers {
    const inputs = [visible, texts, pathDraws, paths, pathLayers];
    const keptContent = this.#layerContent;
    const content =
      !this.#fullDerivation &&
      keptContent !== null &&
      keptContent.inputs.every((input, index) => input === inputs[index])
        ? keptContent.content
        : this.#layerContentOf(visible, texts, pathDraws, paths, pathLayers);
    if (!this.#fullDerivation) this.#layerContent = Object.freeze({ inputs, content });
    const view = { x: camera.position.x, y: camera.position.y, zoom: camera.zoom };
    // V35-K3: blend roots and isolating containers are planned with E41's plan, which also
    // knows how to dissolve a scope (K6, K7).
    if (scopes.some((scope) => scope.effects !== undefined || asksForBlendLayer(scope))) {
      return this.#planWithEffects(scopes, content, view, target);
    }
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
    this.#queueEffectNotices([]);
    this.#queueBlendNotices([]);
    this.#effectStatistics = NO_EFFECT_STATISTICS;
    return {
      order,
      bounds,
      effects: new Map(),
      blends: new Map(),
      contains: (layer) => layer === null || layer === undefined || indices.has(layer),
      indexOf: (layer) => (layer === null || layer === undefined ? -1 : (indices.get(layer) ?? -1)),
    };
  }

  /**
   * E41 contract, U4b: the layer plan of a scene with effect roots (`planEffectLayers`). A
   * dissolved scope's content draws in its nearest drawn ancestor.
   */
  #planWithEffects(
    scopes: readonly LayerScope[],
    content: ReadonlyMap<LayerScope, readonly SceneBounds[]>,
    view: Readonly<{ x: number; y: number; zoom: number }>,
    target: PrimitiveTarget,
  ): DrawnLayers {
    // Section 5.4: the device limit when the backend passes it (U5), else the option's.
    const maxTextureDimension = target.maxTextureDimension2D ?? this.#maxTextureDimension;
    // V35-K6, K7: with V-35 requests, the plan that drops them where needed; V-35 layers need a
    // backend that draws the blend composite (`blendLayers`).
    const plan = scopes.some(asksForBlendLayer)
      ? planBlendLayers(
          scopes,
          content,
          view,
          target,
          maxTextureDimension,
          target.blendLayers === true,
        )
      : {
          ...planEffectLayers(scopes, content, view, target, maxTextureDimension),
          blends: new Map<LayerScope, BlendRootMode>(),
          blendNotices: [],
        };
    this.#queueLayerNotices(plan.layerNotices);
    this.#queueEffectNotices(plan.effectNotices);
    this.#queueBlendNotices(plan.blendNotices);
    const states = new Map(plan.states);
    const resolve = (layer: LayerScope | null | undefined): LayerScope | null => {
      let scope = layer ?? null;
      while (scope !== null && states.get(scope) === 'dissolved') scope = scope.parent;
      return scope;
    };
    // An effect root's packet bound is its source bound inside its drawn parent's bound. A
    // backend that draws layers past the target (U5b, `offTargetEffectLayers`) takes the
    // bounds of effect roots and of the layers inside them unclamped (E41-K2, K2c); otherwise
    // each bound is also clamped to the target (E25-K5), as U4b's packet was. An empty bound
    // draws nothing (section 5.3).
    const bounds = new Map<LayerScope, DeviceRect>();
    const targetRect: DeviceRect = { x: 0, y: 0, width: target.width, height: target.height };
    const offTarget = target.offTargetEffectLayers === true;
    const reachRect: DeviceRect = {
      x: -E41_LAYER_REACH_MAX,
      y: -E41_LAYER_REACH_MAX,
      width: target.width + 2 * E41_LAYER_REACH_MAX,
      height: target.height + 2 * E41_LAYER_REACH_MAX,
    };
    const inEffect = (scope: LayerScope): boolean => {
      for (let next: LayerScope | null = scope; next !== null; next = next.parent) {
        if (plan.effects.has(next)) return true;
      }
      return false;
    };
    for (const scope of scopes) {
      if (states.get(scope) !== 'drawn') continue;
      const parent = resolve(scope.parent);
      if (parent !== null && states.get(parent) !== 'drawn') {
        states.set(scope, 'dropped');
        continue;
      }
      // Past the target, a bound stops at E41_LAYER_REACH_MAX (content beyond it casts nothing).
      const bound0 = plan.bounds.get(scope)!;
      let bound: DeviceRect | null =
        offTarget && inEffect(scope)
          ? intersectRects(bound0, reachRect)
          : intersectRects(bound0, targetRect);
      if (bound !== null && parent !== null) bound = intersectRects(bound, bounds.get(parent)!);
      if (bound === null) {
        states.set(scope, 'dropped');
        continue;
      }
      bounds.set(scope, bound);
    }
    const effects = new Map([...plan.effects].filter(([scope]) => states.get(scope) === 'drawn'));
    this.#effectStatistics = Object.freeze({
      roots: effects.size,
      clampedSigmas: [...effects.values()].reduce((sum, e) => sum + e.effects.clamped, 0),
    });
    const order = scopes
      .filter((scope) => states.get(scope) === 'drawn')
      .sort(
        (left, right) =>
          left.end - right.end || right.start - left.start || right.depth - left.depth,
      );
    const indices = new Map(order.map((scope, index) => [scope, index] as const));
    return {
      order,
      bounds,
      effects,
      blends: new Map([...plan.blends].filter(([scope]) => states.get(scope) === 'drawn')),
      contains: (layer) => {
        const scope = resolve(layer);
        return scope === null || indices.has(scope);
      },
      indexOf: (layer) => {
        const scope = resolve(layer);
        return scope === null ? -1 : (indices.get(scope) ?? -1);
      },
    };
  }

  #queueEffectNotices(notices: readonly EffectBudgetNotice[]): void {
    const current = new Set(notices.map((notice) => notice.nodeId));
    for (const notice of notices) {
      if (this.#effectsOverBudget.has(notice.nodeId)) continue;
      if (this.#effectNotices.length < LAYER_NOTICES_QUEUED) this.#effectNotices.push(notice);
      else this.#effectNoticesDropped += 1;
    }
    this.#effectsOverBudget = current;
  }

  #queueBlendNotices(notices: readonly BlendResourceNotice[]): void {
    const current = new Set(notices.map((notice) => notice.nodeId));
    for (const notice of notices) {
      if (this.#blendOverBudget.has(notice.nodeId)) continue;
      if (this.#blendNotices.length < LAYER_NOTICES_QUEUED) this.#blendNotices.push(notice);
      else this.#blendNoticesDropped += 1;
    }
    this.#blendOverBudget = current;
  }

  /** V35-K6: blend resource notices dropped because the queue was full. */
  public getBlendNoticesDropped(): number {
    return this.#blendNoticesDropped;
  }

  /** E41-S8: effect budget notices dropped because the queue was full. */
  public getEffectNoticesDropped(): number {
    return this.#effectNoticesDropped;
  }

  /** E41-K4: the last frame's drawn effect roots and clamped σ (statistics). */
  public getEffectStatistics(): Readonly<{ roots: number; clampedSigmas: number }> {
    return this.#effectStatistics;
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
    primitiveClip: ((primitive: DerivedPrimitive) => ClipChain | null) | null = null,
    composites: readonly (ClipChain | null)[] = [],
  ): ClipStates {
    this.#clipStates.begin();
    const primitiveStates: number[] = [];
    const meshStates: number[] = [];
    const clipOf = primitiveClip ?? ((primitive: DerivedPrimitive) => primitive.clip);
    let next = 0;
    for (const draw of meshDraws) {
      while (next < visible.length && visible[next]!.sequence < draw.sequence) {
        primitiveStates.push(this.#clipStates.stateOf(clipOf(visible[next]!)));
        next += 1;
      }
      meshStates.push(this.#clipStates.stateOf(draw.clip));
    }
    for (; next < visible.length; next += 1) {
      primitiveStates.push(this.#clipStates.stateOf(clipOf(visible[next]!)));
    }
    // E41-K2b: the effect roots' composite chains, after the draws.
    const compositeStates = composites.map((chain) => this.#clipStates.stateOf(chain));
    return { primitiveStates, meshStates, compositeStates, records: this.#clipStates.end() };
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

  /** @internal Tests only (E28 section 4, Counters): glyph raster port calls so far. */
  public getGlyphRasterCallsForTesting(): number {
    return this.#atlas?.rasterCalls ?? 0;
  }

  /** @internal Tests only (E28 section 4, Counters): bitmaps written by acknowledged packets. */
  public getGlyphUploadsForTesting(): number {
    return this.#atlas?.uploads ?? 0;
  }

  /** @internal Tests only (E28 section 4, Counters): atlas pages evicted by acknowledged packets. */
  public getAtlasEvictionsForTesting(): number {
    return this.#atlas?.evictions ?? 0;
  }

  /** E28 section 5: text notices dropped because the queue was full. */
  public getTextNoticesDropped(): number {
    return this.#atlas?.noticesDropped ?? 0;
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
    // E28 section 4, Lifetime: the receipt has a text part exactly when the packet has one, and
    // the atlas frame commits only with the rest of the packet.
    const textFrame = pending.text;
    if ((pending.packet.text === undefined) !== (receipt.text === undefined)) return;
    if (
      textFrame !== null &&
      (this.#atlas === null || !this.#atlas.validateReceipt(textFrame, receipt.text))
    ) {
      return;
    }
    const received = validateReceiptResources(receipt, pending.expected, this.#incarnations);
    if (received === null) return;
    this.#pending = null;
    if (textFrame !== null && this.#atlas !== null) {
      const lost = this.#atlas.acknowledge(textFrame, receipt.text!);
      // Deferred clusters invalidate once per acknowledged packet; so does a page whose entries
      // were lost to a new incarnation.
      if (textFrame.deferred > 0 || lost) {
        try {
          this.#onTextDeferred?.();
        } catch {
          // The invalidation target is the host's; a throw never fails the acknowledgement.
        }
      }
    }
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
    this.#atlas?.reset();
    this.#keptText = null;
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
          layoutVersion: 1 as const,
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
        layoutVersion: 1 as const,
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
          const sequence = sequences.get(draw.nodeId)!;
          // E30-U3b: a draw with the kept placement and sequence keeps its kept objects, so the
          // passes after it keep theirs.
          const kept = this.#fullDerivation ? undefined : this.#meshPartDraws.get(draw);
          if (
            kept !== undefined &&
            kept.sequence === sequence &&
            kept.draw.firstTriangle === placement.firstTriangle &&
            kept.draw.triangleCount === placement.triangleCount
          ) {
            return kept;
          }
          const made = Object.freeze({
            sequence,
            draw: Object.freeze({
              instance: draw.slot,
              firstTriangle: placement.firstTriangle,
              triangleCount: placement.triangleCount,
              // ST-U7 addendum, section 4.5: only a joint fill draw carries the field.
              ...(draw.composite === undefined ? {} : { composite: draw.composite }),
              // E39-R8: a winding or union draw carries its coverage (and a winding its rule).
              ...(draw.coverage === undefined ? {} : { coverage: draw.coverage }),
              ...(draw.fillRule === undefined ? {} : { fillRule: draw.fillRule }),
            }),
          });
          if (!this.#fullDerivation) this.#meshPartDraws.set(draw, made);
          return made;
        }),
      ),
      expected: output.expected,
    });
  }

  /**
   * E28 contract, U2: the atlas plan over the drawn text leaves. E30 contract, section 4.2 (U4c):
   * a frame with the same drawn leaves, camera and target as the last one repeats its atlas frame
   * when the atlas shows that planning would find every cluster where it was.
   */
  #textFrame(
    texts: readonly DerivedText[],
    derivedTexts: DerivedTexts,
    camera: Readonly<{ position: Readonly<{ x: number; y: number }>; zoom: number }>,
    target: PrimitiveTarget,
  ): TextFrame {
    const atlas = this.#atlas!;
    const scene = this.#sceneGenerations(derivedTexts);
    const key = [
      camera.position.x,
      camera.position.y,
      camera.zoom,
      target.generation,
      target.width,
      target.height,
      target.devicePixelRatio,
    ];
    const kept = this.#keptText;
    if (
      !this.#fullDerivation &&
      kept !== null &&
      derivedTexts.held &&
      kept.held &&
      kept.texts === texts &&
      numericArraysEqual(kept.key, key)
    ) {
      const repeated = repeatTextFrame(atlas, kept.frame, scene);
      if (repeated !== null) {
        this.#textFrameCounts.repeated += 1;
        this.#keptText = Object.freeze({ ...kept, frame: repeated });
        return repeated;
      }
    }
    this.#textFrameCounts.planned += 1;
    const frame = planTextFrame(atlas, texts, derivedTexts.held, camera, target, scene);
    this.#keptText = Object.freeze({ texts, held: derivedTexts.held, key, frame });
    return frame;
  }

  /**
   * V-21 (contract, section 4.3): the layout generations the scene's text leaves carry, hidden and
   * off-screen ones included. The same set object is returned until the generations change, so
   * the atlas re-checks obsolescence only then.
   */
  #sceneGenerations(texts: DerivedTexts): ReadonlySet<number> {
    const known = this.#generations;
    if (known !== null && known.texts === texts) return known.set;
    const set = new Set(texts.leaves.map((leaf) => leaf.node.generation));
    const same =
      known !== null && known.set.size === set.size && [...set].every((g) => known.set.has(g));
    this.#generations = { texts, set: same ? known.set : set };
    return this.#generations.set;
  }

  /** P4 contract, U4: the drawn content's clip chains in paint order (camera-independent). */
  #maskContentOf(
    visible: readonly DerivedPrimitive[],
    pathDraws: readonly PathMeshDraw[],
    texts: readonly DerivedText[],
    pathSequences: ReadonlyMap<string, number>,
    pathClips: ReadonlyMap<string, ClipChain | null>,
    pathLayers: ReadonlyMap<string, LayerScope | null>,
    effectClips: EffectClips | null,
  ): readonly Readonly<{ sequence: number; chain: ClipChain | null }>[] {
    const inputs = [visible, pathDraws, texts, pathSequences, pathClips, pathLayers, effectClips];
    const kept = this.#maskContent;
    if (
      !this.#fullDerivation &&
      kept !== null &&
      kept.inputs.every((input, index) => input === inputs[index])
    ) {
      return kept.content;
    }
    const chainOf = (chain: ClipChain | null, layer: LayerScope | null | undefined) =>
      effectClips === null ? chain : effectClips.chainOf(chain, layer);
    const content = [
      ...visible.map((primitive) => ({
        sequence: primitive.sequence,
        chain: chainOf(primitive.clip, primitive.layer),
      })),
      ...pathDraws
        .filter((draw) => draw.maskSource !== true)
        .map((draw) => ({
          sequence: pathSequences.get(draw.nodeId)!,
          chain: chainOf(pathClips.get(draw.nodeId) ?? null, pathLayers.get(draw.nodeId)),
        })),
      ...texts.map((text) => ({ sequence: text.sequence, chain: chainOf(text.clip, text.layer) })),
    ].sort((left, right) => left.sequence - right.sequence);
    if (!this.#fullDerivation) this.#maskContent = Object.freeze({ inputs, content });
    return content;
  }

  /**
   * E41-K2b: the frame's effect clips, kept while the drawn roots are the same scope objects in
   * the same order (a resolver depends only on them and their ancestors), so the mask content and
   * the mask plan keep their reuse across frames.
   */
  #effectClipsOf(plan: DrawnLayers | null): EffectClips | null {
    const roots = plan === null ? [] : plan.order.filter((scope) => plan.effects.has(scope));
    const kept = this.#effectClips;
    if (
      !this.#fullDerivation &&
      kept !== null &&
      kept.roots.length === roots.length &&
      kept.roots.every((root, index) => root === roots[index])
    ) {
      return kept.clips;
    }
    const clips = effectClipResolver(plan);
    if (!this.#fullDerivation) this.#effectClips = Object.freeze({ roots, clips });
    return clips;
  }

  /** E30-U3b: the kept array for this name when it holds the same items, else this one. */
  #intern<T>(name: string, items: T[]): T[] {
    if (this.#fullDerivation) return items;
    const kept = this.#interned.get(name) as T[] | undefined;
    if (kept !== undefined && sameItems(kept, items)) return kept;
    this.#interned.set(name, items);
    return items;
  }

  /**
   * The visible primitives and text leaves. E26 contract, U5c, and E30-U3b: kept while the
   * derivation's leaves and the target size stay the same and the camera stays in the range over
   * which every cull decision holds.
   */
  #cull(
    derivation: Derivation,
    camera: Readonly<{ position: Readonly<{ x: number; y: number }>; zoom: number }>,
    target: PrimitiveTarget,
  ): Readonly<{ visible: DerivedPrimitive[]; texts: DerivedText[] }> {
    const key = [target.width, target.height, target.devicePixelRatio];
    const kept = this.#culled;
    // E30 contract, section 4.1, condition 1: the kept decisions hold over their camera range.
    if (
      !this.#fullDerivation &&
      kept !== null &&
      kept.primitives === derivation.primitives &&
      kept.leaves === derivation.texts.leaves &&
      numericArraysEqual(kept.key, key) &&
      rangeHolds(kept.range, camera)
    ) {
      this.#cullCounts.kept += 1;
      return kept;
    }
    // E30 contract, section 4.2 (U4b): after a leaf-only set, the replaced leaves are decided
    // alone at this camera; every other leaf keeps its decision, which holds over the range.
    const patched =
      this.#fullDerivation ||
      kept === null ||
      !numericArraysEqual(kept.key, key) ||
      !rangeHolds(kept.range, camera)
        ? null
        : this.#patchCull(kept, derivation, camera, target);
    if (patched !== null) {
      this.#cullCounts.patched += 1;
      this.#culled = patched;
      return patched;
    }
    this.#cullCounts.culls += 1;
    const candidates = derivation.primitives.filter(
      (entry) => !entry.hidden && !entry.omitted && entry.clip?.empty !== true,
    );
    let visible = cullPrimitives(candidates, camera, target);
    // E28-K9: text leaves cull by their node bound and clip chain as primitives do.
    const textCandidates = derivation.texts.leaves.filter(
      (text) => !text.hidden && text.clip?.empty !== true,
    );
    let texts = cullTexts(textCandidates, camera, target);
    let range = pointRange(camera);
    if (!this.#fullDerivation) {
      // The same decisions keep the kept arrays, so the passes keyed by them keep their work.
      if (
        kept !== null &&
        kept.primitives === derivation.primitives &&
        kept.leaves === derivation.texts.leaves
      ) {
        if (sameItems(kept.visible, visible)) visible = kept.visible;
        if (sameItems(kept.texts, texts)) texts = kept.texts;
      }
      const drawnPrimitives = new Set(visible);
      const drawnTexts = new Set(texts);
      const items: { bounds: SceneBounds; clip: ClipChain | null; drawn: boolean }[] = [];
      for (const primitive of candidates) {
        items.push({
          ...cullTarget(primitive.worldBounds, primitive.clip, primitive.reach),
          drawn: drawnPrimitives.has(primitive),
        });
      }
      for (const text of textCandidates) {
        // A leaf without a bound is never drawn, at any camera.
        if (text.worldBounds === null) continue;
        items.push({
          ...cullTarget(text.worldBounds, text.clip, text.reach),
          drawn: drawnTexts.has(text),
        });
      }
      range = decisionRange(camera, target, undefined, items);
      this.#cullCounts.ranges += 1;
    }
    this.#culled = Object.freeze({
      primitives: derivation.primitives,
      leaves: derivation.texts.leaves,
      key,
      range,
      visible,
      texts,
    });
    return this.#culled;
  }

  /**
   * E30-U4b: the kept cull with the replaced leaves decided afresh, or null when the leaves
   * differ in more than a few entries replaced by leaves with the same IDs. The range narrows to
   * the replaced leaves' decisions; the kept arrays are kept when no replaced leaf is drawn
   * before or after.
   */
  #patchCull(
    kept: KeptCull,
    derivation: Derivation,
    camera: Readonly<{ position: Readonly<{ x: number; y: number }>; zoom: number }>,
    target: PrimitiveTarget,
  ): KeptCull | null {
    const primitiveChanges = replacedEntries(kept.primitives, derivation.primitives);
    if (primitiveChanges === null) return null;
    const textChanges = replacedEntries(kept.leaves, derivation.texts.leaves);
    if (textChanges === null) return null;
    const items: { bounds: SceneBounds; clip: ClipChain | null; drawn: boolean }[] = [];
    const visible = patchDrawn(
      kept.primitives,
      derivation.primitives,
      kept.visible,
      primitiveChanges,
      (primitive) => {
        if (primitive.hidden || primitive.omitted || primitive.clip?.empty === true) return false;
        const drawn = cullPrimitives([primitive], camera, target).length === 1;
        items.push({
          ...cullTarget(primitive.worldBounds, primitive.clip, primitive.reach),
          drawn,
        });
        return drawn;
      },
    );
    const texts = patchDrawn(
      kept.leaves,
      derivation.texts.leaves,
      kept.texts,
      textChanges,
      (text) => {
        if (text.hidden || text.clip?.empty === true) return false;
        const drawn = cullTexts([text], camera, target).length === 1;
        if (text.worldBounds !== null) {
          items.push({ ...cullTarget(text.worldBounds, text.clip, text.reach), drawn });
        }
        return drawn;
      },
    );
    const range =
      items.length === 0
        ? kept.range
        : intersectRanges(kept.range, decisionRange(camera, target, undefined, items));
    return Object.freeze({
      primitives: derivation.primitives,
      leaves: derivation.texts.leaves,
      key: kept.key,
      range,
      visible,
      texts,
    });
  }

  /** The derived paths by ID, built once per paths array (E26-U5c). */
  #pathsById(paths: readonly DerivedPath[]): ReadonlyMap<string, DerivedPath> {
    let byId = this.#pathMaps.get(paths);
    if (byId === undefined || this.#fullDerivation) {
      byId = new Map(paths.map((path) => [path.id, path] as const));
      this.#pathMaps.set(paths, byId);
    }
    return byId;
  }

  /** The derived paths' clip chains by ID, built once per paths array (E26-U5c). */
  #pathClips(paths: readonly DerivedPath[]): ReadonlyMap<string, ClipChain | null> {
    let clips = this.#pathClipMaps.get(paths);
    if (clips === undefined || this.#fullDerivation) {
      clips = new Map(paths.map((path) => [path.id, path.clip ?? null] as const));
      this.#pathClipMaps.set(paths, clips);
    }
    return clips;
  }

  /**
   * E26 contract, U5c: the scene's derivation, kept when nothing was written since it, patched
   * when the writes were leaf-only (`patchDerivation`), and otherwise derived in full.
   */
  #derive(scene: RetainedSceneView): Derivation {
    const kept = this.#derivation;
    const changed = kept === null || this.#fullDerivation ? null : scene.changedSince(kept.serial);
    let derivation: Derivation | null = null;
    if (kept !== null && changed !== null) {
      if (changed.length === 0 && sameIds(kept.rootOrder, scene.rootOrder)) {
        derivation =
          kept.serial === scene.changeSerial
            ? kept
            : Object.freeze({ ...kept, serial: scene.changeSerial });
        this.#derivationCounts.reused += 1;
      } else {
        derivation = patchDerivation(kept, scene, changed, this.#derivedCache, this.#slots);
        if (derivation !== null) {
          this.#derivationCounts.patched += 1;
          this.#derivationCounts.leaves += new Set(changed).size;
        }
      }
    }
    if (derivation === null) {
      derivation = derivePrimitives(
        scene,
        this.#slots,
        this.#derivedCache,
        this.#isolateUnitOpacity,
      );
      this.#derivationCounts.full += 1;
      this.#derivationCounts.leaves += derivation.leaves.size;
    }
    this.#derivation = derivation;
    return derivation;
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
    this.#derivation = null;
    this.#packingKeys.clear();
    this.#reconstructedEpoch = null;
    this.#reconstructedIncarnation = null;
  }

  /**
   * Frees the slots of primitives the scene no longer holds and gives new primitives the lowest
   * free slots in ordinal order. With the IDs written since the slots were last reconciled
   * (E26-U5c), only those are visited; null visits the whole scene.
   */
  #reconcileSlots(scene: RetainedSceneView, changed: readonly string[] | null): void {
    const visited = changed === null ? scene.nodes.map((node) => node.id) : changed;
    const primitiveIds = new Set<string>();
    for (const id of visited) {
      if (scene.getNode(id)?.kind === 'primitive') primitiveIds.add(id);
    }
    const freed = changed === null ? [...this.#slots.keys()] : changed;
    for (const id of freed) {
      const slot = this.#slots.get(id);
      if (slot === undefined || primitiveIds.has(id)) continue;
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
    // E26 contract, U5c: the assessment is a function of the primitive and these inputs, so a
    // primitive that passed under the same inputs passes again and is not assessed twice.
    const key = [
      camera.position.x,
      camera.position.y,
      camera.zoom,
      target.devicePixelRatio,
      target.width,
      target.height,
      origin.x,
      origin.y,
    ];
    if (!numericArraysEqual(this.#assessedKey, key)) {
      this.#assessedKey = key;
      this.#assessed = new WeakSet();
    }
    const assessed = this.#assessed;
    const ranged = this.#fullDerivation ? null : this.#packingRangeAt(camera, target, origin);
    for (const primitive of primitives) {
      if (!this.#fullDerivation && assessed.has(primitive)) continue;
      // E30 contract, U3b: a primitive whose bound over a range holding the camera is within the
      // budget passes at this camera; the bound is taken once per primitive and range.
      if (ranged !== null) {
        if (ranged.passed.has(primitive)) {
          this.#packingCounts.ranged += 1;
          continue;
        }
        if (!ranged.declined.has(primitive)) {
          const bound = primitivePackingBoundOver(
            primitive.world,
            primitive.localBounds,
            origin,
            ranged.range,
            target.devicePixelRatio,
            target.width,
            target.height,
            primitive.node,
          );
          const limit = PACKING_BUDGET_PX * (1 - 1e-9);
          if (bound !== null && bound.quantization <= limit && bound.arithmetic <= limit) {
            ranged.passed.add(primitive);
            this.#packingCounts.ranged += 1;
            continue;
          }
          ranged.declined.add(primitive);
        }
      }
      this.#packingCounts.perCamera += 1;
      // E26 contract, U5d: the unclipped bound decides most primitives; the rest are assessed.
      if (
        !this.#fullDerivation &&
        primitivePackingWithinBudget(
          primitive.world,
          primitive.localBounds,
          origin,
          camera.position,
          camera.zoom,
          target.devicePixelRatio,
          target.width,
          target.height,
          PACKING_BUDGET_PX,
          primitive.node,
        )
      ) {
        assessed.add(primitive);
        continue;
      }
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
        assessment.quantizationPhysicalPixels > PACKING_BUDGET_PX ||
        assessment.arithmeticPhysicalPixels > PACKING_BUDGET_PX
      ) {
        throw new PrimitiveNumericPreparationError('packet v1 position precision budget exceeded');
      }
      assessed.add(primitive);
    }
  }

  /**
   * E30 contract, U3b: the packing range holding this camera under these packing inputs: the
   * kept one while it holds, else a new one around the camera (zoom within 1/16 of it, positions
   * within a quarter of the viewport), whose bounds are taken afresh.
   */
  #packingRangeAt(
    camera: Readonly<{ position: Readonly<{ x: number; y: number }>; zoom: number }>,
    target: PrimitiveTarget,
    origin: Origin,
  ): PackingRange | null {
    const { zoom, position } = camera;
    if (!(zoom > 0 && Number.isFinite(zoom + position.x + position.y))) return null;
    const key = [target.devicePixelRatio, target.width, target.height, origin.x, origin.y];
    const kept = this.#packingRange;
    if (kept !== null && numericArraysEqual(kept.key, key) && rangeHolds(kept.range, camera)) {
      return kept;
    }
    const spanX = target.width / target.devicePixelRatio / zoom / 4;
    const spanY = target.height / target.devicePixelRatio / zoom / 4;
    const range: CameraRange = Object.freeze({
      zoomMin: zoom / (1 + PACKING_RANGE_ZOOM),
      zoomMax: zoom * (1 + PACKING_RANGE_ZOOM),
      minX: position.x - spanX,
      maxX: position.x + spanX,
      minY: position.y - spanY,
      maxY: position.y + spanY,
    });
    if (!rangeHolds(range, camera)) return null;
    this.#packingCounts.ranges += 1;
    this.#packingRange = Object.freeze({
      key,
      range,
      passed: new WeakSet(),
      declined: new WeakSet(),
    });
    return this.#packingRange;
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
      // E26 contract, U5c: the keys are functions of the derived primitive and the origin, so a
      // kept primitive whose keys were taken under this origin writes nothing. The origin is
      // compared with the keys' own, not with the last frame's: a frame that selected a new origin
      // may have thrown before it wrote any record.
      if (
        !forceTransforms &&
        !this.#fullDerivation &&
        previous?.primitive === primitive &&
        previous.transform[6] === origin.x &&
        previous.transform[7] === origin.y
      ) {
        continue;
      }
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
          primitive,
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

/** One traversal position: the node and what its ancestors give it. */
type DeriveItem = Readonly<{
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
  /** E41-K3: the reach of the effect roots above the node, or null outside them. */
  reach: EffectReach | null;
}>;

/** Where a leaf sits in the derivation, so a set that changes only leaves can patch it. */
type DerivedLeaf = Readonly<{
  kind: 'primitive' | 'path' | 'text';
  item: DeriveItem;
  sequence: number;
  /** The leaf's index in `primitives`, `paths` or `texts.leaves`, by kind. */
  index: number;
}>;

/**
 * The scene's derivation (E26 contract, U5c): kept between frames and replaced only when the
 * scene changes. Nothing in it depends on the camera or the target. Its arrays, maps and layer
 * scopes are shared by later frames, so nothing after `derivePrimitives` may mutate them (a
 * `LayerScope`'s `end` is written only while deriving).
 */
type Derivation = Readonly<{
  /** The view's `changeSerial` this derivation is current at. */
  serial: number;
  rootOrder: readonly string[];
  primitives: readonly DerivedPrimitive[];
  paths: readonly DerivedPath[];
  pathSequences: ReadonlyMap<string, number>;
  clipSeen: boolean;
  layerScopes: readonly LayerScope[];
  pathLayers: ReadonlyMap<string, LayerScope>;
  texts: Readonly<DerivedTexts>;
  leaves: ReadonlyMap<string, DerivedLeaf>;
}>;

function derivePrimitives(
  scene: RetainedSceneView,
  slots: ReadonlyMap<string, number>,
  cache: Map<string, DerivedCacheEntry>,
  isolateUnitOpacity = false,
): Derivation {
  const result: DerivedPrimitive[] = [];
  const paths: DerivedPath[] = [];
  const pathSequences = new Map<string, number>();
  let clipSeen = false;
  const layerScopes: LayerScope[] = [];
  const pathLayers = new Map<string, LayerScope>();
  const texts: DerivedTexts = { leaves: [], held: false };
  const leaves = new Map<string, DerivedLeaf>();
  const present = new Set<string>();
  let sequence = 0;
  const rootWorldVersion = Symbol.for('vector-studio.primitive-root-world');
  const stack: DeriveItem[] = [...scene.rootOrder].reverse().map((id) => ({
    id,
    parentWorld: IDENTITY,
    parentWorldVersion: rootWorldVersion,
    parentHidden: false,
    chain: null,
    maskSource: false,
    sourceChain: null,
    layer: null,
    reach: null,
  }));
  // E25 contract, U2: a leaf extends every enclosing layer's sequence range.
  const extendLayers = (layer: LayerScope | null) => {
    for (let scope = layer; scope !== null; scope = scope.parent) scope.end = sequence + 1;
  };
  while (stack.length > 0) {
    const item = stack.pop()!;
    const node = scene.getNode(item.id)!;
    present.add(node.id);
    if (node.kind !== 'container') {
      // E41 section 5.2 and V35-K3: a visible leaf with effects, or with a blend mode, is a
      // layer root of its own.
      const leafRoot = leafEffectScope(node, item, sequence);
      if (leafRoot !== null) layerScopes.push(leafRoot);
      const leafItem =
        leafRoot === null
          ? item
          : {
              ...item,
              layer: leafRoot,
              reach:
                leafRoot.effects === undefined
                  ? item.reach
                  : extendEffectReach(item.reach, leafRoot.effects, leafRoot.world!, item.chain),
            };
      const leaf = deriveLeaf(node, leafItem, sequence, cache, slots);
      if (leaf.kind === 'primitive') {
        leaves.set(node.id, { kind: 'primitive', item, sequence, index: result.length });
        result.push(leaf.primitive);
      } else if (leaf.kind === 'path') {
        leaves.set(node.id, { kind: 'path', item, sequence, index: paths.length });
        paths.push(leaf.path);
        pathSequences.set(node.id, sequence);
        if (leafItem.layer !== null) pathLayers.set(node.id, leafItem.layer);
      } else {
        texts.held = true;
        leaves.set(node.id, { kind: 'text', item, sequence, index: texts.leaves.length });
        texts.leaves.push(leaf.text);
      }
      extendLayers(leafItem.layer);
      sequence += 1;
      continue;
    }
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
    if (node.clip !== null) clipSeen = true;
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
    // E41-K2: a mask group under an effect root clamps that root's bounds to the target.
    if (isMask && !subtreeHidden) {
      for (let scope = item.layer; scope !== null; scope = scope.parent) {
        if (scope.effects !== undefined) scope.hasMask = true;
      }
    }
    // E41 section 5.2: a visible container with effects is a layer root too; with
    // 0 < opacity < 1 it is one layer, not two.
    const effects = node.effects !== undefined && node.effects.length > 0 ? node.effects : null;
    const isolated = node.opacity < 1 || isolateUnitOpacity;
    // V35-K3: a container blend root, or an isolating container (mode `normal`); a mask source's
    // mode is ignored (it never paints). It is one layer with an E25 layer or effect root.
    const blendFields = blendScopeFields(node.blendMode, isolated || effects !== null);
    let reach = item.reach;
    if (!subtreeHidden && (isolated || effects !== null || blendFields !== null)) {
      if (effects !== null) reach = extendEffectReach(item.reach, effects, world, item.chain);
      layer = {
        nodeId: node.id,
        opacity: node.opacity,
        parent: item.layer,
        depth: item.layer === null ? 0 : item.layer.depth + 1,
        chain,
        start: sequence,
        end: sequence,
        ...(effects === null
          ? {}
          : // E41-K2: the root's own mask is target-based too.
            { effects, world, isolated, outerChain: item.chain, hasMask: isMask }),
        ...blendFields,
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
        reach,
      });
    }
  }
  for (const id of cache.keys()) if (!present.has(id)) cache.delete(id);
  return Object.freeze({
    serial: scene.changeSerial,
    rootOrder: scene.rootOrder,
    primitives: result,
    paths,
    pathSequences,
    clipSeen,
    layerScopes,
    pathLayers,
    texts,
    leaves,
  });
}

/**
 * E41 section 5.2: the layer scope of a leaf effect root (a visible leaf with effects and
 * opacity above 0, not a mask source), or null. Its draws keep the leaf's opacity
 * (`contentOpacity`), so the composite itself is at opacity 1; dropping its effects dissolves it.
 */
function leafEffectScope(
  node: Exclude<RenderNodeSnapshot, { kind: 'container' }>,
  item: DeriveItem,
  sequence: number,
): LayerScope | null {
  const effects = node.effects !== undefined && node.effects.length > 0 ? node.effects : null;
  // V35-K3: a leaf blend root; `normal` is never stored on a leaf (scene validation drops it).
  const blendFields = blendScopeFields(node.blendMode, effects !== null);
  if (effects === null && blendFields === null) return null;
  if (item.parentHidden || item.maskSource || !node.visible || !(node.opacity > 0)) return null;
  const base = {
    nodeId: node.id,
    opacity: 1,
    parent: item.layer,
    depth: item.layer === null ? 0 : item.layer.depth + 1,
    chain: item.chain,
    start: sequence,
    end: sequence,
    ...blendFields,
  };
  // V35-K3: a leaf blend root's draws keep the leaf's opacity, and its `R` is composited at
  // opacity 1 with its mode; dropping its mode dissolves it (the leaf then draws directly).
  if (effects === null) return base;
  const world = composeSceneAffine(item.parentWorld, node.transform);
  if (world === null) return null;
  return {
    ...base,
    effects,
    world,
    isolated: false,
    contentOpacity: node.opacity,
    outerChain: item.chain,
    hasMask: false,
  };
}

/**
 * V35-K3: the layer-scope fields of a node's mode. A mode outside `normal` and `passThrough`
 * makes a blend root (with a backdrop snapshot, margin 0); `normal` on a container makes an
 * isolating container. `blendOnly` marks a scope that is a layer only for V-35 (`layered` is
 * whether E25 or E41 make it one). Null for the defaults.
 */
function blendScopeFields(
  mode: SceneBlendMode | undefined,
  layered: boolean,
): Pick<LayerScope, 'blend' | 'backdrop' | 'isolating' | 'blendOnly'> | null {
  if (mode === undefined || mode === 'passThrough') return null;
  const only = layered ? {} : { blendOnly: true };
  if (mode === 'normal') return { isolating: true, ...only };
  return { blend: mode, backdrop: BLEND_BACKDROP, ...only };
}

/** V35-K4: a blend root reads its backdrop at its own bound (margin 0). */
const BLEND_BACKDROP = Object.freeze({ margin: 0 });

type LeafOutput =
  | Readonly<{ kind: 'primitive'; primitive: DerivedPrimitive }>
  | Readonly<{ kind: 'path'; path: DerivedPath }>
  | Readonly<{ kind: 'text'; text: DerivedText }>;

/** Derives one leaf at its traversal position and updates its cache entry. */
function deriveLeaf(
  node: Exclude<RenderNodeSnapshot, { kind: 'container' }>,
  item: DeriveItem,
  sequence: number,
  cache: Map<string, DerivedCacheEntry>,
  slots: ReadonlyMap<string, number>,
): LeafOutput {
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
    return {
      kind: 'path',
      path: Object.freeze(
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
              ...(item.reach === null ? {} : { reach: item.reach }),
            },
      ),
    };
  }
  // E28 contract, U2: a text node is one leaf at its paint position, with E28-K9 bounds.
  if (node.kind === 'text') {
    const localBounds = getTextLocalBounds(node);
    const worldBounds = localBounds === null ? null : transformSceneBounds(localBounds, world);
    cache.set(
      node.id,
      Object.freeze({
        transform: node.transform,
        parentWorldVersion: item.parentWorldVersion,
        worldVersion,
        world,
        hidden,
        localKey: null,
        localBounds,
        worldBounds,
        omitted: false,
      }),
    );
    return {
      kind: 'text',
      text: Object.freeze({
        id: node.id,
        node,
        world,
        worldBounds,
        hidden: hidden || item.chain?.empty === true,
        clip: item.chain,
        sequence,
        layer: item.layer,
        ...(item.reach === null ? {} : { reach: item.reach }),
      }),
    };
  }
  const localKey = primitiveBoundsKey(node);
  const boundsChanged =
    worldChanged || previous === undefined || !numericArraysEqual(previous.localKey, localKey);
  const localBounds = boundsChanged ? getPrimitiveLocalStrokeBounds(node)! : previous.localBounds!;
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
  return {
    kind: 'primitive',
    primitive: Object.freeze({
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
      ...(item.reach === null ? {} : { reach: item.reach }),
    }),
  };
}

/**
 * E26 contract, U5c: the derivation after a set that wrote only leaves, each still a leaf of the
 * same kind under the same parent and not a mask source, re-derives just those leaves at their
 * kept positions. Anything else (a container, an insert or removal, a mask source, a root order
 * change) returns null, and the caller derives the scene in full.
 */
function patchDerivation(
  previous: Derivation,
  scene: RetainedSceneView,
  changed: readonly string[],
  cache: Map<string, DerivedCacheEntry>,
  slots: ReadonlyMap<string, number>,
): Derivation | null {
  if (!sameIds(previous.rootOrder, scene.rootOrder)) return null;
  const ids = new Set(changed);
  const updates: { leaf: DerivedLeaf; node: Exclude<RenderNodeSnapshot, { kind: 'container' }> }[] =
    [];
  for (const id of ids) {
    const leaf = previous.leaves.get(id);
    const node = scene.getNode(id);
    if (leaf === undefined || node === undefined || node.kind === 'container') return null;
    if (leaf.item.maskSource) return null;
    if (node.kind !== leaf.kind) return null;
    const before =
      leaf.kind === 'primitive'
        ? previous.primitives[leaf.index]!.node
        : leaf.kind === 'path'
          ? previous.paths[leaf.index]!.node
          : previous.texts.leaves[leaf.index]!.node;
    // Defensive: a valid set that moves a leaf also writes a container or the root order.
    if (before.parentId !== node.parentId) return null;
    // E41: a leaf effect root owns a layer scope, which only a full derivation rebuilds; so does
    // a leaf blend root (V35-K3).
    if ((before.effects?.length ?? 0) > 0 || (node.effects?.length ?? 0) > 0) return null;
    if (before.blendMode !== undefined || node.blendMode !== undefined) return null;
    updates.push({ leaf, node });
  }
  if (updates.length === 0) return Object.freeze({ ...previous, serial: scene.changeSerial });
  let primitives: DerivedPrimitive[] | null = null;
  let paths: DerivedPath[] | null = null;
  let textLeaves: DerivedText[] | null = null;
  for (const { leaf, node } of updates) {
    const output = deriveLeaf(node, leaf.item, leaf.sequence, cache, slots);
    if (output.kind === 'primitive') {
      primitives ??= [...previous.primitives];
      primitives[leaf.index] = output.primitive;
    } else if (output.kind === 'path') {
      paths ??= [...previous.paths];
      paths[leaf.index] = output.path;
    } else {
      textLeaves ??= [...previous.texts.leaves];
      textLeaves[leaf.index] = output.text;
    }
  }
  return Object.freeze({
    ...previous,
    serial: scene.changeSerial,
    primitives: primitives ?? previous.primitives,
    paths: paths ?? previous.paths,
    texts: textLeaves === null ? previous.texts : Object.freeze({ leaves: textLeaves, held: true }),
  });
}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  if (left === right) return true;
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
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
  /** E41-K2b: the states of `EffectClips.composites`, in its order. */
  compositeStates?: readonly number[];
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
                  ...(draw.coverage === undefined ? {} : { coverage: draw.coverage }),
                  ...(draw.fillRule === undefined ? {} : { fillRule: draw.fillRule }),
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

/**
 * E28 contract, U2: mesh draws and text draws merged by sequence, each list already in sequence
 * order; distinct leaves never share a sequence.
 */
function mergeItems(
  meshSequences: readonly number[],
  textSequences: readonly number[],
): Readonly<{ sequence: number; kind: 'mesh' | 'text'; index: number }>[] {
  if (textSequences.length === 0) {
    return meshSequences.map((sequence, index) => ({ sequence, kind: 'mesh', index }));
  }
  const items: { sequence: number; kind: 'mesh' | 'text'; index: number }[] = [];
  let mesh = 0;
  let text = 0;
  while (mesh < meshSequences.length || text < textSequences.length) {
    if (
      text >= textSequences.length ||
      (mesh < meshSequences.length && meshSequences[mesh]! < textSequences[text]!)
    ) {
      items.push({ sequence: meshSequences[mesh]!, kind: 'mesh', index: mesh });
      mesh += 1;
    } else {
      items.push({ sequence: textSequences[text]!, kind: 'text', index: text });
      text += 1;
    }
  }
  return items;
}

/** E28 section 4: without layers, an item's order counts the items before it at its position. */
function flatOrders(positions: readonly number[]): number[] {
  let order = 0;
  return positions.map((position, index) => {
    order = index > 0 && positions[index - 1] === position ? order + 1 : 0;
    return order;
  });
}

/** E25 contract, U2: the frame's drawn layers, indexed in post-order. */
type DrawnLayers = Readonly<{
  order: readonly LayerScope[];
  bounds: ReadonlyMap<LayerScope, DeviceRect>;
  /** E41: the drawn effect roots. */
  effects: ReadonlyMap<LayerScope, EffectLayer>;
  /** V35-K3: the drawn blend roots and their modes. */
  blends: ReadonlyMap<LayerScope, BlendRootMode>;
  /** Whether content of `layer` is drawn (in it, or in an ancestor it dissolves into). */
  contains(layer: LayerScope | null | undefined): boolean;
  /** The layer's index in `order` (after dissolving), or -1 for the main pass. */
  indexOf(layer: LayerScope | null | undefined): number;
}>;

/**
 * E41-K2b: the clip chains of a frame with drawn effect roots. `chainOf` rebases a draw's chain
 * at the innermost drawn root around its layer; `composites` holds each root's composite chain
 * (its ancestors' chain rebased at the root around it), in the plan's root order.
 */
type EffectClips = Readonly<{
  chainOf(chain: ClipChain | null, layer: LayerScope | null | undefined): ClipChain | null;
  composites: ReadonlyMap<LayerScope, ClipChain | null>;
  /** Whether every drawn root around `layer` has its composite chain admitted. */
  rootsAdmitted(plan: MaskPlan, layer: LayerScope | null | undefined): boolean;
}>;

function effectClipResolver(plan: DrawnLayers | null): EffectClips | null {
  if (plan === null || plan.effects.size === 0) return null;
  const roots = new Map<LayerScope, LayerScope | null>();
  const rootOf = (layer: LayerScope | null | undefined): LayerScope | null => {
    if (layer === null || layer === undefined) return null;
    let root = roots.get(layer);
    if (root === undefined) {
      root = plan.effects.has(layer) ? layer : rootOf(layer.parent);
      roots.set(layer, root);
    }
    return root;
  };
  const chainOf = (chain: ClipChain | null, layer: LayerScope | null | undefined) => {
    const root = rootOf(layer);
    return root === null ? chain : rebaseClipChain(chain, root.outerChain ?? null, root.nodeId);
  };
  const composites = new Map<LayerScope, ClipChain | null>();
  for (const root of plan.order) {
    if (plan.effects.has(root)) composites.set(root, chainOf(root.outerChain ?? null, root.parent));
  }
  // Per plan: a kept resolver serves later frames' plans too.
  const admittedByPlan = new WeakMap<MaskPlan, Map<LayerScope, boolean>>();
  const rootsAdmitted = (masks: MaskPlan, layer: LayerScope | null | undefined): boolean => {
    const root = rootOf(layer);
    if (root === null) return true;
    let admitted = admittedByPlan.get(masks);
    if (admitted === undefined) {
      admitted = new Map();
      admittedByPlan.set(masks, admitted);
    }
    let known = admitted.get(root);
    if (known === undefined) {
      known = masks.admit(composites.get(root) ?? null) && rootsAdmitted(masks, root.parent);
      admitted.set(root, known);
    }
    return known;
  };
  return Object.freeze({ chainOf, composites, rootsAdmitted });
}

/** E41-K2b: an effect root's composite carries the state of its composite chain. */
function compositeClipStates(
  composites: readonly LayerComposite[],
  plan: DrawnLayers | null,
  effectClips: EffectClips | null,
  clip: ClipStates,
): readonly LayerComposite[] {
  if (effectClips === null || plan === null || clip.compositeStates === undefined) {
    return composites;
  }
  const states = new Map<LayerScope, number>();
  [...effectClips.composites.keys()].forEach((root, index) =>
    states.set(root, clip.compositeStates![index] ?? 0),
  );
  return composites.map((composite) => {
    const state = states.get(plan.order[composite.layer]!) ?? 0;
    return state === 0 ? composite : Object.freeze({ ...composite, clipState: state });
  });
}

/** E41: the packet record of a drawn effect root, spread into its layer entry. */
/** V35-K3, K4: a drawn blend root's mode and backdrop request, for its packet layer. */
function blendRecordOf(
  blend: BlendRootMode | undefined,
  scope: LayerScope,
): { blend?: BlendRootMode; backdrop?: Readonly<{ margin: number }> } {
  if (blend === undefined) return {};
  return { blend, backdrop: scope.backdrop ?? Object.freeze({ margin: 0 }) };
}

function effectRecordOf(effect: EffectLayer | undefined): { effect?: LayerEffectRecord } {
  if (effect === undefined) return {};
  return {
    effect: Object.freeze({
      source: effect.source,
      output: effect.output,
      shadows: effect.effects.shadows,
      blurSigmaPx: effect.effects.blurSigmaPx,
      contentOpacity: effect.contentOpacity,
    }),
  };
}

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
 * layer. Primitives, non-analytic items (mesh and text draws) and composites are merged in paint
 * order; a composite sits at its layer's first sequence, before that leaf, outer layers first. A
 * run extends only over consecutive order-stream entries of one target with equal clip state and
 * paint; an item or a composite closes its target's run. E28 section 4: each item and composite
 * gets its `order`, the number of its target's items and composites at an equal position before
 * it.
 */
function interleaveLayerDraws(
  visible: readonly DerivedPrimitive[],
  visibleTargets: readonly number[],
  itemSequences: readonly number[],
  itemTargets: readonly number[],
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
  main: PrimitiveDraw[];
  positions: number[];
  orders: number[];
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
  const positions: number[] = [];
  const orders: number[] = [];
  const placed: LayerComposite[] = [];
  /** The order of the next non-analytic draw at the run's current position. */
  const nextOrder = (run: Run, position: number) => {
    const order = run.lastPosition === position ? run.atPosition : 0;
    run.lastPosition = position;
    run.atPosition = order + 1;
    return order;
  };
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
            order: nextOrder(run, position),
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
  itemSequences.forEach((sequence, index) => {
    // Composites at the draw's own sequence precede it: they open the layers it is drawn in.
    advanceTo(sequence, true);
    const run = runOf(itemTargets[index]!);
    close(run);
    const position = run.analytic.length;
    positions.push(position);
    orders.push(nextOrder(run, position));
  });
  advanceTo(Infinity, true);
  for (const run of runs) close(run);
  return {
    main: runOf(-1).analytic,
    positions,
    orders,
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

function sameItems<T>(left: readonly T[], right: readonly T[]): boolean {
  return left.length === right.length && left.every((item, index) => item === right[index]);
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
  return primitives.filter((primitive) => {
    // E41-K3: inside effect roots, the bound grown by their reach.
    const { bounds, clip } = cullTarget(primitive.worldBounds, primitive.clip, primitive.reach);
    return (
      bounds.maxX >= viewport.minX &&
      bounds.minX <= viewport.maxX &&
      bounds.maxY >= viewport.minY &&
      bounds.minY <= viewport.maxY &&
      meetsClipChain(bounds, clip, guard)
    );
  });
}

/** The kept cull (E26-U5c, E30-U3b). */
type KeptCull = Readonly<{
  primitives: readonly DerivedPrimitive[];
  leaves: readonly DerivedText[];
  /** The target size and DPR the decisions were taken under. */
  key: readonly number[];
  /** E30-U3b: the cameras at which every cull decision is the kept one. */
  range: CameraRange;
  visible: DerivedPrimitive[];
  texts: DerivedText[];
}>;

/**
 * E30-U4b: the indices at which `next` replaces entries of `previous` by entries with the same
 * IDs, ascending; null when the lengths or an ID differ, or more than a few entries changed.
 */
function replacedEntries<T extends Readonly<{ id: string }>>(
  previous: readonly T[],
  next: readonly T[],
): number[] | null {
  if (previous === next) return [];
  if (previous.length !== next.length) return null;
  const limit = Math.max(64, next.length >> 3);
  const indices: number[] = [];
  for (let index = 0; index < next.length; index += 1) {
    const before = previous[index]!;
    const after = next[index]!;
    if (before === after) continue;
    if (before.id !== after.id || indices.length === limit) return null;
    indices.push(index);
  }
  return indices;
}

/**
 * E30-U4b: the drawn subsequence of `next` (in its order) from the kept drawn subsequence of
 * `previous`, with the entries at `replaced` decided by `decide`. The kept array is returned when
 * no replaced entry is drawn before or after.
 */
function patchDrawn<T>(
  previous: readonly T[],
  next: readonly T[],
  drawn: T[],
  replaced: readonly number[],
  decide: (entry: T) => boolean,
): T[] {
  if (replaced.length === 0) return drawn;
  const decisions = new Map<number, boolean>();
  for (const index of replaced) decisions.set(index, decide(next[index]!));
  // Whether each replaced entry was drawn: the kept drawn entries are a subsequence of `previous`.
  const before = new Set<number>();
  let position = 0;
  for (let index = 0; index < previous.length && position < drawn.length; index += 1) {
    if (drawn[position] !== previous[index]) continue;
    if (decisions.has(index)) before.add(index);
    position += 1;
  }
  if (before.size === 0 && [...decisions.values()].every((value) => !value)) return drawn;
  const result: T[] = [];
  position = 0;
  for (let index = 0; index < next.length; index += 1) {
    const wasDrawn = position < drawn.length && drawn[position] === previous[index];
    if (wasDrawn) position += 1;
    const decision = decisions.get(index);
    if (decision === undefined ? wasDrawn : decision) result.push(next[index]!);
  }
  return result;
}

/** E28-K9: text leaves cull by their node bound and clip chain, with primitives' 2 px guard. */
function cullTexts(
  texts: readonly DerivedText[],
  camera: Readonly<{ position: Readonly<{ x: number; y: number }>; zoom: number }>,
  target: PrimitiveTarget,
): DerivedText[] {
  const guard = 2 / (camera.zoom * target.devicePixelRatio);
  const minX = camera.position.x - guard;
  const minY = camera.position.y - guard;
  const maxX = camera.position.x + target.width / target.devicePixelRatio / camera.zoom + guard;
  const maxY = camera.position.y + target.height / target.devicePixelRatio / camera.zoom + guard;
  return texts.filter((text) => {
    if (text.worldBounds === null) return false;
    const { bounds, clip } = cullTarget(text.worldBounds, text.clip, text.reach);
    return (
      bounds.maxX >= minX &&
      bounds.minX <= maxX &&
      bounds.maxY >= minY &&
      bounds.minY <= maxY &&
      meetsClipChain(bounds, clip, guard)
    );
  });
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
