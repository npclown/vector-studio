import type { ImageSourcePort, SceneColor, SceneVersion } from '@vector-studio/contracts';
import type { ClipStateRecord, MaskBudgetNotice, MaskLevelRecord } from './clip-resolution.js';
import type { EffectBudgetNotice } from './effect-plan.js';
import type { DeviceRect, LayerResourceNotice } from './layer-plan.js';
import type { GradientPaintRecord } from './paint-records.js';
import type { PathMeshNotice } from './path-mesh-pipeline.js';
import type { TextClear, TextNotice, TextReceiptPart, TextUpload } from './text-atlas.js';

export type { TextReceiptPart } from './text-atlas.js';

export type PrimitiveResourceId = 'transforms' | 'geometry' | 'styles' | 'order' | 'frame';
export type PrimitiveTarget = Readonly<{
  generation: number;
  surfaceRevision: number;
  width: number;
  height: number;
  devicePixelRatio: number;
  sampleCount: 1 | 4;
  targetFormat: 'bgra8unorm' | 'rgba8unorm';
  /**
   * E41 section 5.4: the device's `maxTextureDimension2D`, set by a backend for a source that
   * asks for the effect pipeline; absent, the source keeps its option's value.
   */
  maxTextureDimension2D?: number;
  /**
   * E41 U5b: whether the backend draws an effect root's layer (and the layers inside it) past
   * the target. Absent or false, those bounds are clamped to the target (U4b's packet). U5c:
   * true also rebases the clip chains inside an effect root (E41-K2b), whose composite then
   * carries a clip state; a backend sets it only when it draws the effect passes.
   */
  offTargetEffectLayers?: boolean;
}>;
export type PrimitiveRecordVersion = Readonly<{ index: number; version: symbol }>;
export type PrimitiveResource = Readonly<{
  id: PrimitiveResourceId;
  incarnation: symbol;
  capacityBytes: number;
}>;
export type PrimitiveWrite = Readonly<{
  resourceId: PrimitiveResourceId;
  incarnation: symbol;
  byteOffset: number;
  bytes: Uint8Array;
  records: readonly PrimitiveRecordVersion[];
}>;
export type PrimitiveDraw = Readonly<{
  first: number;
  count: number;
  variant: 'analytic-v1';
  /** P4 contract, U2: the 1-based clip state of a clipped run; absent when unclipped. */
  clipState?: number;
  /**
   * E23 contract, U2: present only on a run whose primitives have a gradient record (the paint
   * part's `primitives`); such a run uses the paint pipeline variant.
   */
  paint?: 'gradient';
  /**
   * V-32 contract (V32-K7): on a paint run whose primitives' fill is an image paint, its image
   * key; every primitive of the run has the same one, and the backend binds its texture.
   */
  image?: string;
}>;
/**
 * E23 contract, U2: the frame's gradient records, present only when a drawn draw has one.
 * Record indices are 1-based into `records`; 0 is a solid paint or an out-of-range record
 * (E23-K8), whose solid lanes are transparent. Plain records; U3 owns the GPU layout.
 */
export type PaintPacketPart = Readonly<{
  layoutVersion: 0;
  records: readonly GradientPaintRecord[];
  /** Per primitive slot with a gradient record: its fill and stroke indices. */
  primitives: readonly Readonly<{ slot: number; fill: number; stroke: number }>[];
  /** The primitive origin, which primitive records are rebased to. */
  origin: Readonly<{ x: number; y: number }>;
  /** The mesh origin O_m, which mesh records are rebased to. */
  meshOrigin: Readonly<{ x: number; y: number }>;
  /** Records built this frame (values changed); a camera change builds none. */
  builds: number;
}>;
/**
 * P4 contract, U4: a mask level of the clip part. A mesh source carries its packed fill draw in
 * the mesh part's resources, or null when it did not reach the packet (it then covers nothing).
 */
export type ClipMaskPacketLevel = Omit<MaskLevelRecord, 'source'> &
  Readonly<{
    source:
      | Readonly<{ kind: 'primitive'; slot: number }>
      | Readonly<{
          kind: 'mesh';
          nodeId: string;
          draw: Readonly<
            { instance: number; firstTriangle: number; triangleCount: number } & MeshCoverage
          > | null;
        }>;
  }>;
/**
 * P4 contract, U2: the frame's clip states, present only when a drawn draw is clipped. Plain
 * records; U3 and U4 own their GPU layout.
 */
export type ClipPacketPart = Readonly<{
  layoutVersion: 0;
  /** In index order; indices may have gaps, so a GPU table is sized by `maxIndex`. */
  states: readonly ClipStateRecord[];
  maxIndex: number;
  /**
   * U4: the frame's drawable mask levels, each after its parent level; empty without a mask
   * level. A content state reads the level named last in its `masks`.
   */
  masks: readonly ClipMaskPacketLevel[];
  /**
   * U3: the packet's primitive origin, which rect records are rebased to on the GPU so a camera
   * move rewrites no record, and the camera, which maps a physical pixel to the world:
   * `world = camera + pixel / (zoom * devicePixelRatio)`.
   */
  origin: Readonly<{ x: number; y: number }>;
  camera: Readonly<{ x: number; y: number; zoom: number }>;
}>;
/** P3 V3 contract, section f: the optional mesh packet part, version 0. */
export type MeshResourceId =
  | 'meshPositions'
  | 'meshTriangles'
  | 'meshFeatureLists'
  | 'meshFeatures'
  | 'meshInstances'
  | 'meshFrame';
/**
 * E39 contract, R8: how a mesh draw is resolved. Absent: a partition mesh (E17 write-once).
 * `winding`: a fill's winding mesh, counted in the stencil and covered under `fillRule`.
 * `union`: a stroke's union mesh, marked in the stencil and covered. A winding or union draw's
 * last two triangles are its cover quad (R3); the ones before them are its stencil triangles.
 */
export type MeshCoverage = Readonly<{
  coverage?: 'winding' | 'union';
  /** Present exactly on a `winding` draw. */
  fillRule?: 'nonzero' | 'evenodd';
}>;
export type MeshFillDraw = MeshCoverage &
  Readonly<{
    /** Number of analytic draws that precede this draw in paint order; equal values keep array order. */
    position: number;
    /** Path slot; selects the meshInstances record. */
    instance: number;
    /** Absolute record index in meshTriangles. */
    firstTriangle: number;
    /**
     * Region and exterior triangles of the served variant, > 0; for a winding or union draw its
     * stencil triangles then its two cover triangles (E39-R3), so at least 3.
     */
    triangleCount: number;
    /**
     * ST-U7 addendum, section 4.5: present only on a joint fill draw, which uses the joint
     * pipeline over the overlay variant's triangles and reads the stroke record named by word 15
     * of its instance record (stroke slot + 1). Absent on every other draw; layoutVersion stays 0.
     */
    composite?: 'joint-fill';
    /** P4 contract, U2: the 1-based clip state of a clipped draw; absent when unclipped. */
    clipState?: number;
    /**
     * E23 contract, U2: the 1-based paint-part record of this draw's paint (the fill for a fill
     * or joint fill draw, the stroke for a stroke draw); absent for a solid paint.
     */
    gradient?: number;
    /**
     * E23 contract, U2: on a joint fill draw only, the record of the stroke paint it reads for
     * a_S (E23-K4); absent when the stroke is solid. A joint fill draw with either field uses the
     * paint variant.
     */
    strokeGradient?: number;
  }>;
export type MeshResource = Readonly<{
  id: MeshResourceId;
  incarnation: symbol;
  capacityBytes: number;
}>;
/**
 * E26 contract, U5a: `count` consecutive mesh records from `index`, written with one version. A
 * write's ranges cover its byte range in order, without gaps or overlap.
 */
export type MeshRecordRange = Readonly<{ index: number; count: number; version: symbol }>;
export type MeshWrite = Readonly<{
  resourceId: MeshResourceId;
  incarnation: symbol;
  byteOffset: number;
  bytes: Uint8Array;
  records: readonly MeshRecordRange[];
}>;
export type MeshPacketPart = Readonly<{
  /** E39-R8: layout version 1 adds the draws' coverage. */
  layoutVersion: 1;
  originRevision: symbol;
  /** The six resources in fixed order, or none for a part that carries notices only. */
  resources: readonly MeshResource[];
  writes: readonly MeshWrite[];
  draws: readonly MeshFillDraw[];
  notices: readonly PathMeshNotice[];
}>;
export type MeshReceiptResource = Readonly<{
  resourceId: MeshResourceId;
  incarnation: symbol;
  records: readonly MeshRecordRange[];
}>;
/** `skipped`: the mesh path is unavailable for this generation; only the P1 part is acknowledged. */
export type MeshReceiptPart =
  | Readonly<{
      status: 'submitted';
      originRevision: symbol;
      resources: readonly MeshReceiptResource[];
    }>
  | Readonly<{ status: 'skipped' }>;
/**
 * E25 contract, section 4: the frame's isolated layers, absent when no layer is drawn and no
 * notice is pending. The packet's `draws` and `mesh.draws` hold only main-pass draws; a layer's
 * own draws sit in its entry, with mesh positions counted within the layer.
 */
export type LayerPacketPart = Readonly<{
  layoutVersion: 0;
  /** Post-order: every layer comes after the layers nested in it. */
  layers: readonly Readonly<{
    nodeId: string;
    /** The composite record of E25-A04. */
    opacity: number;
    /** E25-K5, in target pixels; x and y even, width and height even unless clamped. */
    bound: DeviceRect;
    /** Index of the enclosing layer in `layers`, or -1 for the main pass. */
    parent: number;
    draws: readonly PrimitiveDraw[];
    meshDraws: readonly MeshFillDraw[];
    /**
     * E41 contract, section 5.2: present on an effect root drawn with its effects. `bound` is
     * then its source bound clamped to the target and its parent, so that until a backend draws
     * the effect passes (U5) the layer composites as an E25 layer (5.3).
     */
    effect?: LayerEffectRecord;
  }>[];
  /** One per layer, each in its target's paint order. */
  composites: readonly Readonly<{
    layer: number;
    /** -1: the main pass; otherwise the index of the parent layer. */
    target: number;
    /** Number of the target's analytic draws that precede it, as `MeshFillDraw.position`. */
    position: number;
    /**
     * E28 contract, section 4 (renamed from E25's `meshOrder`): the number of the target's
     * non-analytic draws (mesh draws, composites and text draws) with an equal position that
     * precede it.
     */
    order: number;
    /**
     * E41-K2b: on an effect root's composite only, the 1-based clip state of its ancestors' clip
     * chain (rebased at the root around it), applied once to `R`; absent when unclipped. The
     * root's draws carry their chains rebased at the root, so `L` holds no level above it.
     */
    clipState?: number;
  }>[];
  /** Layer trees newly over the budget, at most 32. Emitted as `render.layer-resource-limit`. */
  notices: readonly LayerResourceNotice[];
  /**
   * E41-S8: trees whose effects were newly dropped, at most 32. Emitted as
   * `render.effect-resource-limit`. Absent when none is pending.
   */
  effectNotices?: readonly EffectBudgetNotice[];
}>;

/** E41 contract, section 5.2: an effect root's passes, in device pixels (E41-S9, K2). */
export type LayerEffectRecord = Readonly<{
  /**
   * K2's source bound, where `L` is rendered; unlike `bound`, which until U5 is this bound
   * clamped as an E25 layer's, it may pass the target and its parent.
   */
  source: DeviceRect;
  /** K2's output bound: `R` and the composite quad. */
  output: DeviceRect;
  /** Drop shadows in list order, offsets and σ in device pixels, σ clamped (K4). */
  shadows: readonly Readonly<{ color: SceneColor; dx: number; dy: number; sigmaPx: number }>[];
  /** The layer blur's σ in device pixels, or null. */
  blurSigmaPx: number | null;
  /** V-36 contract, V36-K2: inner shadows in list order, as `shadows`; absent when none. */
  innerShadows?: readonly Readonly<{
    color: SceneColor;
    dx: number;
    dy: number;
    sigmaPx: number;
  }>[];
  /** V36 section 5: the background blur's σ in device pixels, clamped; absent without one. */
  backgroundBlur?: Readonly<{ sigmaPx: number }>;
  /**
   * V36-K1b: the sides where `bound` is cut short of the root's content (bit 1 left, 2 top,
   * 4 right, 8 bottom); `harden` reads `L` clamped there. Absent when 0 or without inner shadows.
   */
  innerClamp?: number;
  /** A leaf root's opacity, which its draws in `L` keep; 1 for a container root. */
  contentOpacity: number;
}>;
/** E28 contract, section 4: a text draw, ordered against its target's draws as a composite. */
export type TextDraw = Readonly<{
  /** First instance record and record count. */
  first: number;
  count: number;
  page: number;
  /** -1: the main pass; otherwise an index into the layer part's `layers`. */
  target: number;
  /** Number of the target's analytic draws that precede it, as `MeshFillDraw.position`. */
  position: number;
  /** Number of the target's non-analytic draws with an equal position that precede it. */
  order: number;
  /** P4: the 1-based clip state of a clipped draw; absent when unclipped. */
  clipState?: number;
}>;
/**
 * E28 contract, section 4: the frame's text, absent when no text is drawn, the atlas holds no
 * page and no notice is pending. While the atlas holds pages the part is present, so
 * `pageCount` keeps them for culled text; the frame after the scene's last text node goes
 * carries `pageCount` 0, which releases them.
 */
export type TextPacketPart = Readonly<{
  layoutVersion: 0;
  pageSize: number;
  pageCount: number;
  /** Areas zeroed this frame, before uploads. */
  clears: readonly TextClear[];
  uploads: readonly TextUpload[];
  /**
   * 16 floats per instance: device quad origin (2), the quad's x and y axis vectors (4), the
   * texel rect x, y, width, height (4), page, mode (0 snapped, 1 general) and the premultiplied
   * colour (4), in target pixels.
   */
  instances: Float32Array;
  draws: readonly TextDraw[];
  /** E28-D2 and D3, at most 32. */
  notices: readonly TextNotice[];
}>;
export type PrimitivePacket = Readonly<{
  layoutVersion: 1;
  scene: SceneVersion;
  sceneEpoch: symbol;
  cameraRevision: number;
  surfaceRevision: number;
  originRevision: symbol;
  generation: number;
  packetId: symbol;
  mode: 'reconstruct' | 'incremental';
  resources: readonly PrimitiveResource[];
  writes: readonly PrimitiveWrite[];
  draws: readonly PrimitiveDraw[];
  frame: PrimitiveTarget;
  /** Absent for every primitive-only scene (P3 V3 contract, section f). */
  mesh?: MeshPacketPart;
  /** Absent for every unclipped frame (P4 contract, U2). */
  clip?: ClipPacketPart;
  /** Absent for every frame without a drawn gradient record (E23 contract, U2). */
  paint?: PaintPacketPart;
  /**
   * P4 contract, U4 and section 5: mask levels newly over the mask texture budget, at most 32;
   * absent when none. Emitted as `render.clip-resource-limit`.
   */
  clipNotices?: readonly MaskBudgetNotice[];
  /** Absent for every frame without a drawn layer or a pending layer notice (E25 contract, U2). */
  layers?: LayerPacketPart;
  /** Absent for every scene without text (E28 contract, section 4). */
  text?: TextPacketPart;
}>;
export type PrimitiveReceipt = Readonly<{
  scene: SceneVersion;
  sceneEpoch: symbol;
  cameraRevision: number;
  surfaceRevision: number;
  originRevision: symbol;
  generation: number;
  packetId: symbol;
  submissionSerial: number;
  resources: readonly Readonly<{
    resourceId: PrimitiveResourceId;
    incarnation: symbol;
    records: readonly PrimitiveRecordVersion[];
  }>[];
  /** Present exactly when the packet has a mesh part. */
  mesh?: MeshReceiptPart;
  /** Present exactly when the packet has a text part (E28 contract, section 4, Lifetime). */
  text?: TextReceiptPart;
}>;
export type PrimitiveSubmitResult =
  | Readonly<{ status: 'submitted'; receipt: PrimitiveReceipt }>
  | Readonly<{ status: 'not-ready' | 'stale-generation' }>
  | Readonly<{
      status: 'failed';
      reason: 'invalid-packet' | 'allocation-failed' | 'submission-failed';
    }>;
export interface PrimitivePacketConsumer {
  submitPrimitivePacket(packet: PrimitivePacket): PrimitiveSubmitResult;
}
export interface PrimitiveFrameSource {
  /**
   * True when the backend must create the mesh pipeline at initialization and recovery
   * (P3 V3 contract, section f). Optional; absent means false.
   */
  readonly requiresMeshPipeline?: boolean;
  /**
   * P4 contract, U3: true when the backend must create the clip pipeline variants at
   * initialization and recovery. Optional; absent means false.
   */
  readonly requiresClipPipeline?: boolean;
  /**
   * E23 contract, U3: true when the backend must create the gradient paint pipeline variants
   * at initialization and recovery. Optional; absent means false.
   */
  readonly requiresPaintPipeline?: boolean;
  /**
   * E25 contract, U3: true when the backend must create the layer variants and the composite
   * pipeline at initialization and recovery. Optional; absent means false.
   */
  readonly requiresLayerPipeline?: boolean;
  /**
   * E28 contract, E28-S3: true when the backend must create the text pipeline and its variants
   * at initialization and recovery. Optional; absent means false.
   */
  readonly requiresTextPipeline?: boolean;
  /**
   * E41 contract, U5: true when the backend must create the effect pipelines (with the layer
   * pipeline) at initialization and recovery. Optional; absent means false.
   */
  readonly requiresEffectPipeline?: boolean;
  /**
   * V-32 contract (V32-P1): the image source port the backend's texture store requests drawn
   * image keys from. Optional; absent means image paints bind the transparent texture.
   */
  readonly imageSource?: ImageSourcePort;
  prepare(target: PrimitiveTarget): PrimitivePacket | null;
  acknowledge(receipt: PrimitiveReceipt): void;
}
