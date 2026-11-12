import type { ResourceDescriptor } from '@vector-studio/contracts';
import type {
  ClipMaskPacketLevel,
  ClipPacketPart,
  DeviceRect,
  GradientPaintRecord,
  LayerEffectRecord,
  LayerPacketPart,
  MeshCoverage,
  MeshFillDraw,
  MeshPacketPart,
  MeshReceiptPart,
  MeshReceiptResource,
  MeshRecordRange,
  MeshResourceId,
  PrimitiveDraw,
  PrimitivePacket,
  PrimitiveReceipt,
  PrimitiveRecordVersion,
  PrimitiveResourceId,
  PrimitiveSubmitResult,
  PrimitiveTarget,
  TextDraw,
  TextPacketPart,
  TextReceiptPart,
} from '@vector-studio/renderer-core';
import {
  E25_LAYER_TILE_SIZE,
  E28_ATLAS_PAGES_MAX,
  E28_ATLAS_PAGE_SIZE,
  E41_LAYER_REACH_MAX,
  E41_SIGMA_PX_MAX,
  maskTileSet,
  planBackdropSplits,
} from '@vector-studio/renderer-core';
import {
  CLIP_BINDINGS,
  CLIP_BIND_GROUP_INDEX,
  CLIP_FRAME_SIZE,
  CLIP_MASK_FORMAT,
  CLIP_STATE_SIZE,
  MESH_FILL_CLIP_SHADER,
  MESH_FILL_MASK_SHADER,
  PRIMITIVE_ANALYTIC_CLIP_SHADER,
  PRIMITIVE_ANALYTIC_MASK_SHADER,
  clipStateStride,
  clipVariantKey,
  createClipBindGroupLayoutDescriptor,
  packClipFrame,
  packClipState,
} from './clip-pipeline.js';
import { CaptureError, PendingCapture, type CountPipelineState } from './frame-capture.js';
import {
  MESH_COUNT_FRAGMENT_ENTRY_POINT,
  MESH_COUNT_READOUT_SHADER,
  MESH_COUNT_SHADER,
} from './mesh-count-shader.js';
import { MESH_FILL_SHADER, MESH_JOINT_VERTEX_ENTRY_POINT } from './mesh-fill-shader.js';
import {
  GRADIENT_RECORD_SIZE,
  MESH_FILL_PAINT_CLIP_SHADER,
  MESH_FILL_PAINT_SHADER,
  PAINT_BINDINGS,
  PAINT_BIND_GROUP_INDEX,
  PRIMITIVE_ANALYTIC_PAINT_CLIP_SHADER,
  PRIMITIVE_ANALYTIC_PAINT_SHADER,
  createPaintBindGroupLayoutDescriptor,
  packGradientRecord,
  packPaintIndices,
  paintClipVariantKey,
  paintVariantKey,
} from './paint-pipeline.js';
import {
  MESH_FRAME_SIZE,
  MESH_PACKET_BINDINGS,
  MESH_PACKET_LAYOUT_VERSION,
  MESH_REQUIRED_BINDINGS_PER_BIND_GROUP,
  MESH_REQUIRED_STORAGE_BUFFERS_PER_STAGE,
  MESH_RESOURCE_IDS,
  MESH_RESOURCE_STRIDES,
  createMeshBindGroupLayoutDescriptor,
  createMeshPipelineDescriptor,
  createMeshStencilResetPipelineDescriptor,
  MESH_STENCIL_RESET_SHADER,
  meshPipelineKey,
  meshWriteOnceStencilState,
  meshCoverStencilState,
  meshJointCoverStencilState,
  createMeshStencilPipelineDescriptor,
  meshStencilPipelineKey,
  meshStencilPassReference,
  MESH_PIPELINE_KINDS,
  MeshStencilSequence,
  MESH_JOINT_COVERS,
  MESH_STENCIL_KINDS,
  meshJointCoverKind,
  encodeMeshJoint,
  type MeshCoverRule,
  type MeshJointCover,
  type MeshPipelineKind,
  type MeshStencilKind,
} from './mesh-pipeline.js';
import {
  LAYER_BIND_GROUP_INDEX,
  LAYER_COMPOSITE_BINDINGS,
  LAYER_COMPOSITE_RECORD_SIZE,
  LAYER_COMPOSITE_SHADER,
  LAYER_PASS_RECORD_SIZE,
  LAYER_REQUIRED_BIND_GROUPS,
  LAYER_VARIANT_SUFFIX,
  MESH_FILL_CLIP_LAYER_SHADER,
  MESH_FILL_LAYER_SHADER,
  MESH_FILL_PAINT_CLIP_LAYER_SHADER,
  MESH_FILL_PAINT_LAYER_SHADER,
  PRIMITIVE_ANALYTIC_CLIP_LAYER_SHADER,
  PRIMITIVE_ANALYTIC_PAINT_CLIP_LAYER_SHADER,
  PRIMITIVE_ANALYTIC_PAINT_LAYER_SHADER,
  createLayerBindGroupLayoutDescriptor,
  createLayerCompositeBindGroupLayoutDescriptor,
  createLayerCompositePipelineDescriptor,
  layerCompositePipelineKey,
  layerVariantBaseKey,
  packLayerCompositeRecord,
  packLayerPassRecord,
  type LayerVariantBase,
} from './layer-pipeline.js';
import {
  EFFECT_BINDINGS,
  EFFECT_PASS_KINDS,
  EFFECT_PASS_RECORD_SIZE,
  EFFECT_SHADER,
  createEffectBindGroupLayoutDescriptor,
  createEffectPipelineDescriptor,
  effectPipelineKey,
  packEffectPassRecord,
  planEffectPasses,
  type EffectPassKind,
  type EffectPassPlan,
  type EffectSurface,
} from './effect-pipeline.js';
import {
  PipelineCache,
  type PipelineCacheKey,
  type PipelineCacheSnapshot,
} from './pipeline-cache.js';
import {
  LAYER_COMPOSITE_SHIFTED_SHADER,
  MESH_FILL_CLIP_SHIFTED_SHADER,
  MESH_FILL_PAINT_CLIP_SHIFTED_SHADER,
  MESH_FILL_PAINT_SHIFTED_SHADER,
  MESH_FILL_SHIFTED_SHADER,
  PRIMITIVE_ANALYTIC_CLIP_SHIFTED_SHADER,
  PRIMITIVE_ANALYTIC_PAINT_CLIP_SHIFTED_SHADER,
  PRIMITIVE_ANALYTIC_PAINT_SHIFTED_SHADER,
  PRIMITIVE_ANALYTIC_SHIFTED_SHADER,
  SHIFTED_LAYER_VARIANT_SUFFIX,
  TEXT_CLIP_SHIFTED_SHADER,
  TEXT_SHIFTED_SHADER,
  shiftedCompositeKey,
  shiftedLayerVariantKey,
} from './shifted-layer-pipeline.js';
import { PRIMITIVE_ANALYTIC_SHADER } from './primitive-analytic-shader.js';
import {
  EFFECT_COMPOSITE_CLIP_SHADER,
  EFFECT_COMPOSITE_CLIP_SHIFTED_SHADER,
  createEffectCompositeClipPipelineDescriptor,
  effectCompositeClipKey,
  effectCompositeClipShiftedKey,
} from './effect-composite-pipeline.js';
import {
  BACKDROP_SNAPSHOT_BINDINGS,
  BACKDROP_SNAPSHOT_RECORD_SIZE,
  backdropRect,
  backdropSnapshotPipelineKey,
  backdropSnapshotShader,
  createBackdropSnapshotBindGroupLayoutDescriptor,
  createBackdropSnapshotPipelineDescriptor,
  packBackdropSnapshotRecord,
  snapshotBackdrop,
  type BackdropParent,
  type BackdropSnapshot,
} from './backdrop-pipeline.js';
import {
  BLEND_COMPOSITE_BINDINGS,
  BLEND_COMPOSITE_VARIANTS,
  BLEND_MODE_INDEX,
  blendCompositePipelineKey,
  blendCompositeVariantSource,
  createBlendCompositeBindGroupLayoutDescriptor,
  createBlendCompositePipelineDescriptor,
  packBlendCompositeRecord,
  type BlendCompositeVariant,
} from './blend-composite-pipeline.js';
import {
  PRIMITIVE_FRAME_SIZE,
  PRIMITIVE_GEOMETRY_STRIDE,
  PRIMITIVE_ORDER_STRIDE,
  PRIMITIVE_PACKET_BINDINGS,
  PRIMITIVE_PACKET_LAYOUT_VERSION,
  PRIMITIVE_STYLE_STRIDE,
  PRIMITIVE_TRANSFORM_STRIDE,
  createPrimitiveBindGroupLayoutDescriptor,
} from './primitive-packet-layout.js';
import {
  type PrimitiveTargetFormat,
  createPrimitivePipelineDescriptor,
  MESH_STENCIL_FORMAT,
  primitivePipelineKey,
} from './primitive-pipeline.js';
import { SharedBufferAllocator, type SharedBufferAllocation } from './shared-buffer-allocator.js';
import { createPrimitiveUnitQuadData } from './primitive-unit-geometry.js';
import {
  TEXT_BINDINGS,
  TEXT_INSTANCE_SIZE,
  TEXT_PAGE_FORMAT,
  TEXT_TARGET_SIZE,
  TEXT_VARIANTS,
  createTextBindGroupLayoutDescriptor,
  createTextPipelineDescriptor,
  createTextSamplerDescriptor,
  packTextTarget,
  textPipelineKey,
  textVariantSource,
  type TextVariant,
} from './text-pipeline.js';
import type {
  WebGpuCanvasContextPort,
  WebGpuPrimitiveSceneCreationPort,
  WebGpuPrimitiveSceneOptions,
  WebGpuPrimitiveScenePort,
  WebGpuPrimitiveSceneResult,
  WebGpuResourceTracker,
  WebGpuSceneCaptureRequestForTesting,
} from './webgpu-platform.js';

/**
 * @internal Tests only (E10 contract, section 3.2): a creation failure caused by a test hook,
 * reported by the backend with this context instead of the error's name and message.
 */
export class TestHookCreationError extends Error {
  public constructor(
    message: string,
    public readonly context: Readonly<Record<string, string | number>>,
  ) {
    super(message);
    this.name = 'TestHookCreationError';
  }
}

const RESOURCE_ORDER = ['transforms', 'geometry', 'styles', 'order', 'frame'] as const;
const RESOURCE_STRIDES: Readonly<Record<PrimitiveResourceId, number>> = Object.freeze({
  transforms: PRIMITIVE_TRANSFORM_STRIDE,
  geometry: PRIMITIVE_GEOMETRY_STRIDE,
  styles: PRIMITIVE_STYLE_STRIDE,
  order: PRIMITIVE_ORDER_STRIDE,
  frame: PRIMITIVE_FRAME_SIZE,
});
const STORAGE_BUFFER_USAGE = 0x80;
const UNIFORM_BUFFER_USAGE = 0x40;
const COPY_DESTINATION_USAGE = 0x08;
const VERTEX_BUFFER_USAGE = 0x20;
const INDEX_BUFFER_USAGE = 0x10;
const RENDER_ATTACHMENT_USAGE = 0x10;
const TEXTURE_BINDING_USAGE = 0x04;
// GPUTextureUsage COPY_SRC and COPY_DST (E22-K2: tiles are copied into the mask textures).
const TEXTURE_COPY_SOURCE_USAGE = 0x01;
const TEXTURE_COPY_DESTINATION_USAGE = 0x02;
const FRAGMENT_STAGE = 0x2;
/** E28 U3: the zeros a page clear is written from, in bands of whole rows. */
const TEXT_ZEROS_SIZE = 64 * 1024;
const TEXT_ZEROS = new Uint8Array(TEXT_ZEROS_SIZE);

interface NativeCanvasContextPort extends WebGpuCanvasContextPort {
  readonly native: GPUCanvasContext;
}

interface ArenaBase {
  readonly id: string;
  readonly bindGroupId: string;
  readonly buffer: GPUBuffer;
  readonly bindGroup: GPUBindGroup;
  readonly allocator: SharedBufferAllocator;
  /** Every allocation of the arena, in region order; each submission marks all of them. */
  readonly allocationList: readonly SharedBufferAllocation[];
  lastSubmittedSerial: number;
  retired: boolean;
  released: boolean;
}

interface ArenaState extends ArenaBase {
  readonly allocations: Readonly<Record<PrimitiveResourceId, SharedBufferAllocation>>;
  readonly incarnations: Readonly<Record<PrimitiveResourceId, symbol>>;
  readonly capacities: Readonly<Record<PrimitiveResourceId, number>>;
  initialized: Readonly<Record<'transforms' | 'geometry' | 'styles', ReadonlySet<number>>>;
  order: ReadonlyMap<number, number>;
  frameInitialized: boolean;
  sceneEpoch: symbol | null;
}

/** The generation-owned mesh arena of P3 V3 section f, under P1's allocator rules. */
interface MeshArenaState extends ArenaBase {
  readonly allocations: Readonly<Record<MeshResourceId, SharedBufferAllocation>>;
  readonly incarnations: Readonly<Record<MeshResourceId, symbol>>;
  readonly capacities: Readonly<Record<MeshResourceId, number>>;
  instances: ReadonlySet<number>;
  /** Word 15 of each written meshInstances record (ST-U7 addendum, section 4.5). */
  links: ReadonlyMap<number, number>;
  frameInitialized: boolean;
}

/** The mesh pipelines created at initialization or recovery; null when unavailable. */
interface MeshPipelineState {
  readonly pipeline: GPURenderPipeline;
  /** ST-U7 addendum, section 4.5: the joint fill pipeline over the same module and layout. */
  readonly jointPipeline: GPURenderPipeline;
  /** E17 contract, section 3: the stencil reset draw's pipeline for the main pass. */
  readonly resetPipeline: GPURenderPipeline;
  /** E17 contract, section 3: the reset module, shared with E10's count reset pipeline. */
  readonly resetShader: GPUShaderModule;
  readonly bindGroupLayout: GPUBindGroupLayout;
  /** E39-R1: the stencil pass pipelines at the main format (main and layer tile passes). */
  readonly stencil: MeshStencilPipelines;
  /** E39-R2: the plain cover pipelines. */
  readonly cover: MeshCoverPipelines;
}

/** E39-R1: a target's stencil pass pipelines, by mesh coverage. */
type MeshStencilPipelines = Readonly<Record<MeshStencilKind, GPURenderPipeline>>;
/**
 * E39-R2: a variant's cover pipelines, by rule (a union mesh uses `nonzero`), and E39-R6's joint
 * covers. A mask tile pass has the two rule covers only (a mask source is never joint).
 */
type MeshCoverPipelines = Readonly<Record<MeshCoverRule | MeshJointCover, GPURenderPipeline>>;
type MeshMaskCoverPipelines = Readonly<Record<MeshCoverRule, GPURenderPipeline>>;

/**
 * E39-R8: a draw's coverage fields: none (partition), `winding` with its fill rule, or `union`
 * without one; a winding or union draw has at least one stencil triangle and its two covers.
 */
function validMeshCoverage(
  draw: Readonly<{ coverage?: unknown; fillRule?: unknown; triangleCount: number }>,
): boolean {
  if (draw.coverage === undefined) return draw.fillRule === undefined;
  if (draw.triangleCount < 3) return false;
  if (draw.coverage === 'union') return draw.fillRule === undefined;
  return (
    draw.coverage === 'winding' && (draw.fillRule === 'nonzero' || draw.fillRule === 'evenodd')
  );
}

/** E39-R8: the cover rule of a winding or union draw. */
function meshCoverRule(draw: Readonly<{ coverage?: string; fillRule?: string }>): MeshCoverRule {
  return draw.coverage === 'winding' && draw.fillRule === 'evenodd' ? 'evenodd' : 'nonzero';
}

/** P4 contract, U3: the rect-clip pipeline variants created at initialization or recovery. */
interface ClipPipelineState {
  readonly bindGroupLayout: GPUBindGroupLayout;
  readonly analytic: GPURenderPipeline;
  /** Null without the mesh path. */
  readonly mesh: GPURenderPipeline | null;
  readonly meshJoint: GPURenderPipeline | null;
  /** E39-R2: the clip variant's covers; null without the mesh path. */
  readonly meshCover: MeshCoverPipelines | null;
  /** U4: the mask pass pipelines, drawing a source's coverage into an `r8unorm` texture. */
  readonly maskAnalytic: GPURenderPipeline;
  /** Null without the mesh path; a mesh source then covers nothing. */
  readonly maskMesh: GPURenderPipeline | null;
  /** E39-R7: a winding mask source's stencil pass and covers at `r8unorm`; null without mesh. */
  readonly maskStencil: GPURenderPipeline | null;
  readonly maskCover: MeshMaskCoverPipelines | null;
  /** U4: the 1 × 1 texture bound for states without a mask level, never read. */
  readonly defaultMask: GPUTexture;
}

/**
 * E23 contract, U3: the gradient paint variants created at initialization or recovery. The
 * clipped ones exist only with the clip variants, the mesh ones only with the mesh path.
 */
interface PaintPipelineState {
  readonly bindGroupLayout: GPUBindGroupLayout;
  /** Bound at group 1 for a paint variant without a clip; its layout has no entry. */
  readonly emptyBindGroup: GPUBindGroup;
  readonly analytic: GPURenderPipeline;
  readonly analyticClip: GPURenderPipeline | null;
  readonly mesh: GPURenderPipeline | null;
  readonly meshJoint: GPURenderPipeline | null;
  readonly meshClip: GPURenderPipeline | null;
  readonly meshJointClip: GPURenderPipeline | null;
  /** E39-R2: the paint variants' covers, unclipped and clipped. */
  readonly meshCover: MeshCoverPipelines | null;
  readonly meshCoverClip: MeshCoverPipelines | null;
}

/**
 * E25 contract, U3: the layer variants and the composite pipeline created at initialization or
 * recovery. A variant exists exactly when its non-layer variant does; the plain analytic module
 * reads no position, so an unclipped solid analytic run in a layer uses the base pipeline.
 */
interface LayerPipelineState {
  readonly bindGroupLayout: GPUBindGroupLayout;
  readonly compositeBindGroupLayout: GPUBindGroupLayout;
  /** Bound at groups 1 and 2 of a layer variant without a clip or a paint. */
  readonly emptyBindGroup: GPUBindGroup;
  /** E28 U3: the empty group's layout, for the text layer variants' layouts. */
  readonly emptyLayout: GPUBindGroupLayout;
  readonly composite: GPURenderPipeline;
  readonly analyticClip: GPURenderPipeline | null;
  readonly analyticPaint: GPURenderPipeline | null;
  readonly analyticPaintClip: GPURenderPipeline | null;
  readonly mesh: GPURenderPipeline | null;
  readonly meshJoint: GPURenderPipeline | null;
  readonly meshClip: GPURenderPipeline | null;
  readonly meshJointClip: GPURenderPipeline | null;
  readonly meshPaint: GPURenderPipeline | null;
  readonly meshJointPaint: GPURenderPipeline | null;
  readonly meshPaintClip: GPURenderPipeline | null;
  readonly meshJointPaintClip: GPURenderPipeline | null;
  /** E39-R7: the layer variants' covers (plain, clip, paint, paint and clip). */
  readonly meshCover: MeshCoverPipelines | null;
  readonly meshCoverClip: MeshCoverPipelines | null;
  readonly meshCoverPaint: MeshCoverPipelines | null;
  readonly meshCoverPaintClip: MeshCoverPipelines | null;
}

/**
 * E28 contract, U3: the text pipelines and the sampler created at initialization or recovery.
 * The clip variants exist only with the clip variants, the layer ones only with the layer
 * pipeline; any creation failure leaves text unavailable for the generation (E28-D1).
 */
interface TextPipelineState {
  readonly bindGroupLayout: GPUBindGroupLayout;
  readonly sampler: GPUSampler;
  readonly plain: GPURenderPipeline;
  readonly clip: GPURenderPipeline | null;
  readonly layer: GPURenderPipeline | null;
  readonly clipLayer: GPURenderPipeline | null;
}

/** E41 U5: the effect module's bind group layout and its pipelines, one per pass kind. */
interface EffectPipelineState {
  readonly bindGroupLayout: GPUBindGroupLayout;
  readonly pipelines: ReadonlyMap<EffectPassKind, GPURenderPipeline>;
  /** E41 U5b: the shifted layer variants every layer pass in or of an effect root uses. */
  readonly shifted: ShiftedLayerPipelines;
  /**
   * E41 U5c: the effect composite's clip variant for the main pass and E25 layer passes; null
   * without the clip variants (a clipped composite is then not drawn, fail closed).
   */
  readonly compositeClip: GPURenderPipeline | null;
}

/**
 * V-35 contract, V35-K4 and K5: the backdrop snapshot pipeline (reading attachments of the
 * scene's sample count) and the blend composite variants. The clip variants exist with the clip
 * variants, the shifted ones with the effect pipeline (passes inside an effect root's `L`).
 */
interface BlendPipelineState {
  readonly snapshotBindGroupLayout: GPUBindGroupLayout;
  readonly snapshot: GPURenderPipeline;
  readonly compositeBindGroupLayout: GPUBindGroupLayout;
  readonly plain: GPURenderPipeline;
  readonly clip: GPURenderPipeline | null;
  readonly shifted: GPURenderPipeline | null;
  readonly clipShifted: GPURenderPipeline | null;
}

/**
 * E41 U5b: the pipelines a layer tile pass draws with. E25's set maps the tile through a
 * target-sized viewport (the base analytic and stencil pipelines, with group 0 only, draw there
 * too); the shifted set maps the tile through its vertex stages (shifted-layer-pipeline.ts), so
 * every pipeline in it, the plain analytic and stencil ones included, has groups 0 to 3.
 */
type LayerDrawPipelines = Readonly<
  Pick<
    LayerPipelineState,
    | 'analyticClip'
    | 'analyticPaint'
    | 'analyticPaintClip'
    | 'mesh'
    | 'meshJoint'
    | 'meshClip'
    | 'meshJointClip'
    | 'meshPaint'
    | 'meshJointPaint'
    | 'meshPaintClip'
    | 'meshJointPaintClip'
    | 'meshCover'
    | 'meshCoverClip'
    | 'meshCoverPaint'
    | 'meshCoverPaintClip'
    | 'composite'
  > & {
    analytic: GPURenderPipeline;
    /** Null without the mesh path. */
    stencil: MeshStencilPipelines | null;
    text: GPURenderPipeline | null;
    textClip: GPURenderPipeline | null;
    /** E41 U5c: the effect composite's clip variant for this set's passes, or null. */
    compositeClip: GPURenderPipeline | null;
    /** V35-K5: the blend composite and its clip variant for this set's passes, or null. */
    blendComposite?: GPURenderPipeline | null;
    blendCompositeClip?: GPURenderPipeline | null;
    /**
     * Whether the plain analytic and stencil pipelines have groups 1 to 3 (the shifted set):
     * the empty groups are then bound before them.
     */
    fullLayouts: boolean;
  }
>;

type ShiftedLayerPipelines = LayerDrawPipelines &
  Readonly<{
    modules: number;
    count: number;
    /** E41 U5c: the effect composite's clip variant for the main pass and E25 passes. */
    targetCompositeClip: GPURenderPipeline | null;
  }>;

/** E28 U3: an atlas page; a new texture is a new incarnation. */
interface TextPage {
  readonly id: string;
  readonly texture: GPUTexture;
  readonly view: GPUTextureView;
  readonly size: number;
  readonly incarnation: symbol;
}

/**
 * E28 U3: the text buffer, the target uniform at offset 0 and the instance records from
 * `instanceOffset`, with a group 0 bind group per page it was bound with.
 */
interface TextBufferState {
  readonly id: string;
  readonly buffer: GPUBuffer;
  readonly size: number;
  readonly instanceOffset: number;
  readonly bindGroups: Map<TextPage, GPUBindGroup>;
  target: Uint8Array | null;
}

/** E28 U3: the text part of a validated packet; null when the packet has none. */
type ValidatedText = Readonly<{
  part: TextPacketPart;
  /** Bytes of the instance records. */
  instanceBytes: number;
  /** False when the records exceed the buffer limits; text is then unavailable (E28-D1). */
  fits: boolean;
}> | null;

/** E23 U3: one paint buffer, the record table or an index table. */
interface PaintTable {
  readonly id: string;
  readonly buffer: GPUBuffer;
  readonly size: number;
}

/**
 * E23 U3: the paint buffers. Record i (1-based) is at i * GRADIENT_RECORD_SIZE; record 0 is
 * never read. The index tables hold a pair per primitive slot and per mesh instance.
 */
interface PaintBufferState {
  readonly records: PaintTable;
  readonly primitives: PaintTable;
  readonly meshes: PaintTable;
  /** Group 2 for analytic draws (binding 1 over the primitive table) and for mesh draws. */
  readonly primitiveBindGroup: GPUBindGroup;
  readonly meshBindGroup: GPUBindGroup;
  /** The bytes last written per record index and per index table; for change-only writes. */
  readonly written: Map<number, Uint8Array>;
  primitiveBytes: Uint8Array | null;
  meshBytes: Uint8Array | null;
}

/** E23 U3: the paint writes of a validated packet; null when it draws no gradient draw. */
type ValidatedPaint = Readonly<{
  /** Per record, index i at position i - 1. */
  records: readonly Uint8Array[];
  primitives: Uint8Array;
  meshes: Uint8Array;
}> | null;

/** U4: a mask level's coverage texture, kept across frames under the level's key. */
interface MaskEntry {
  readonly id: string;
  readonly levelId: string;
  readonly texture: GPUTexture;
  readonly width: number;
  readonly height: number;
  key: string;
  /** The bind group over the clip buffer named by `bindGroupBuffer` and this texture. */
  bindGroup: GPUBindGroup | null;
  bindGroupBuffer: string | null;
}

/** U4: a mask level of a validated packet. */
type PlannedMask = Readonly<{
  level: ClipMaskPacketLevel;
  entry: MaskEntry;
  /** True when the entry was created for this packet and is not yet in the cache. */
  created: boolean;
  /** True when the texture is rendered this frame (a new entry or a changed key). */
  render: boolean;
  /** E22-K2: the level's tiles, each at its offset in the texture with its pass state index. */
  tiles: readonly MaskTile[];
}>;

/** E22-K2: one tile of a mask level's pass; `x` and `y` are offsets in the level's texture. */
type MaskTile = Readonly<{ x: number; y: number; width: number; height: number; state: number }>;

/** P4 contract, U3: the clip buffer, frame lanes at offset 0 and state i at i * stride. */
interface ClipBufferState {
  readonly id: string;
  readonly buffer: GPUBuffer;
  readonly bindGroup: GPUBindGroup;
  /** States the buffer holds: indices 1..capacity. */
  readonly capacity: number;
  /** The bytes last written per state index, and the frame lanes; for change-only writes. */
  readonly written: Map<number, Uint8Array>;
  frame: Uint8Array | null;
}

/** The clip writes of a validated packet; null when it draws no clipped draw. */
type ValidatedClip = Readonly<{
  buffer: ClipBufferState;
  createdBuffer: boolean;
  stride: number;
  frame: Uint8Array;
  states: ReadonlyMap<number, Uint8Array>;
  /** U4: the frame's mask levels in pass order, and each content state's innermost level. */
  masks: readonly PlannedMask[];
  stateMasks: ReadonlyMap<number, string>;
  /** E30-U5 (L3): the planned masks by level ID (IDs are unique), for the per-draw lookup. */
  maskById: ReadonlyMap<string, PlannedMask>;
  /** E22-K1: the extent of the frame's tile set, over all its mask levels. */
  tileSet: Readonly<{ width: number; height: number }>;
}> | null;

/** E30-U5 (L3b): a clip state's packed bytes and the inputs they were packed from. */
type PackedClipState = Readonly<{
  record: ClipPacketPart['states'][number];
  originX: number;
  originY: number;
  maskX: number;
  maskY: number;
  bytes: Uint8Array;
}>;

/** U4 and E22-K1: a tile set attachment, released after the frame's submission. */
type Transient = Readonly<{ id: string; resource: Readonly<{ destroy(): void }> }>;

/** E25 U3: one layer tile pass, at its offset in the layer, with its pass record. */
type LayerTile = Readonly<{ x: number; y: number; width: number; height: number; record: number }>;

/**
 * E28 section 4, Order key: a non-analytic slot of a target other than a mesh draw, a composite
 * (its layer) or a text draw (`layer` null). At each position slot `order` holds it; the other
 * slots hold the mesh draws in array order.
 */
type OrderSlot = Readonly<{
  position: number;
  order: number;
  layer: number | null;
  /** The index of a text draw in the text part's `draws`; null for a composite. */
  text: number | null;
}>;

/**
 * E28 section 4: checks the `order` of composites and text draws per target and merges them in
 * paint order. Each target's composites and text draws come in (position, order) order; orders
 * at a position are distinct and below the number of the target's non-analytic draws there, so
 * every slot is filled. Throws on a violation (`invalid-packet`).
 */
function orderSlots(packet: PrimitivePacket): ReadonlyMap<number, readonly OrderSlot[]> {
  const layers = packet.layers?.layers ?? [];
  const slots = new Map<number, OrderSlot[]>();
  const add = (target: number, slot: OrderSlot, kind: string) => {
    if (
      !Number.isSafeInteger(target) ||
      target < -1 ||
      target >= layers.length ||
      !Number.isSafeInteger(slot.position) ||
      slot.position < 0 ||
      !Number.isSafeInteger(slot.order) ||
      slot.order < 0
    ) {
      throw new Error(`Invalid ${kind} order.`);
    }
    const list = slots.get(target) ?? [];
    list.push(slot);
    slots.set(target, list);
  };
  const ofKind = new Map<string, OrderSlot>();
  for (const composite of packet.layers?.composites ?? []) {
    const slot = {
      position: composite.position,
      order: composite.order,
      layer: composite.layer,
      text: null,
    };
    const previous = ofKind.get(`composite:${composite.target}`);
    if (previous !== undefined && compareSlots(previous, slot) >= 0) {
      throw new Error("A composite out of its target's paint order.");
    }
    ofKind.set(`composite:${composite.target}`, slot);
    add(composite.target, slot, 'composite');
  }
  const textDraws: unknown = packet.text?.draws;
  if (packet.text !== undefined && !Array.isArray(textDraws))
    throw new Error('Invalid text draws.');
  for (const [index, draw] of ((textDraws ?? []) as readonly TextDraw[]).entries()) {
    if (typeof draw !== 'object' || draw === null) throw new Error('Invalid text draw.');
    const slot = { position: draw.position, order: draw.order, layer: null, text: index };
    const previous = ofKind.get(`text:${draw.target}`);
    if (previous !== undefined && compareSlots(previous, slot) >= 0) {
      throw new Error("A text draw out of its target's paint order.");
    }
    ofKind.set(`text:${draw.target}`, slot);
    add(draw.target, slot, 'text');
  }
  for (const [target, list] of slots) {
    list.sort(compareSlots);
    const runs = target === -1 ? packet.draws.length : layers[target]!.draws.length;
    const meshList = target === -1 ? (packet.mesh?.draws ?? []) : layers[target]!.meshDraws;
    // Non-analytic draws per position: mesh draws and these slots.
    const counts = new Map<number, number>();
    for (const draw of meshList) counts.set(draw.position, (counts.get(draw.position) ?? 0) + 1);
    for (const slot of list) counts.set(slot.position, (counts.get(slot.position) ?? 0) + 1);
    list.forEach((slot, index) => {
      const previous = list[index - 1];
      if (
        slot.position > runs ||
        (previous !== undefined && compareSlots(previous, slot) === 0) ||
        slot.order >= counts.get(slot.position)!
      ) {
        throw new Error("A slot out of its target's paint order.");
      }
    });
  }
  return slots;
}

function compareSlots(left: OrderSlot, right: OrderSlot): number {
  return left.position - right.position || left.order - right.order;
}

/** E25 U3: the layers of a validated packet; null when it draws none. */
type ValidatedLayers = Readonly<{
  layers: LayerPacketPart['layers'];
  /** Per target (-1: the main pass), its composites and text draws in paint order (E28). */
  slots: ReadonlyMap<number, readonly OrderSlot[]>;
  /** Per layer, the mesh draws drawn (none when the mesh path is unavailable). */
  meshDraws: readonly (readonly MeshFillDraw[])[];
  /** E41 U5b: per layer, whether its passes use the shifted variants (in or of an effect root). */
  shifted: readonly boolean[];
  /** E41-K2b: per layer, its composite's clip state (0: unclipped; only an effect root's). */
  compositeStates: readonly number[];
  tileWidth: number;
  tileHeight: number;
  tiles: readonly (readonly LayerTile[])[];
  /**
   * Pass records (0: the main pass, then the tiles), one composite record per layer, then the
   * effect pass records.
   */
  records: Uint8Array;
  stride: number;
  compositeRecordBase: number;
  /** E41 U5: per layer, its effect passes, or null for a layer composited as E25's. */
  effects: readonly (LayerEffectFrame | null)[];
  /** E41 U5: the scratch pairs' sizes, in slot order; empty without passes that use them. */
  scratch: readonly Readonly<{ width: number; height: number }>[];
  /**
   * V35-K4, K5: per layer, its blend frame (the snapshot's rectangle) when it composites with
   * its mode, else null (source-over).
   */
  blends: readonly (LayerBlendFrame | null)[];
  /** V35-K4: the splits, keyed by pass (`-1` main, else `layer:tile`), then by blend root. */
  splits: ReadonlyMap<string, ReadonlyMap<number, BlendSplitFrame>>;
  /** V35-K4: the number of splits of the frame. */
  splitCount: number;
}> | null;

/** V35-K4: a blend root's snapshot in a frame, in device pixels. */
type LayerBlendFrame = Readonly<{ snapshot: DeviceRect; margin: number }>;

/** V35-K4: one split: the composite's rectangle in its pass, and its snapshot record. */
type BlendSplitFrame = Readonly<{ rect: DeviceRect; record: number }>;

/** V35-K4: the key of a pass that may split: the main pass, or a layer's tile pass. */
function splitKey(layer: number, tile: number): string {
  return layer === -1 ? '-1' : `${layer}:${tile}`;
}

/**
 * E41 U5: an effect root's passes in a frame. `result` is `R`'s bound (the output bound inside
 * the target and the parent layer), or null when that is empty: the root then has no passes
 * and no composite.
 */
type LayerEffectFrame = Readonly<{
  result: DeviceRect | null;
  plan: EffectPassPlan;
  /** The first pass's record index. */
  recordBase: number;
  /**
   * The scratch pair the root's passes use (an index into `scratch`), or -1 without scratch.
   * Roots run one after another, so a pair is shared by every root that fits it.
   */
  scratchSlot: number;
}>;

/** E25 U3: a frame's layer resources, released with the frame's transients. */
type LayerFrame = Readonly<{
  passGroup: GPUBindGroup;
  compositeGroups: readonly GPUBindGroup[];
  /** E41-K2b: per layer, its composite's clip state (0: unclipped). */
  compositeStates: readonly number[];
  textures: readonly GPUTexture[];
  /** E41 U5: layers without a composite (an effect root whose `R` is empty). */
  skipped: ReadonlySet<number>;
  /** V35-K4: per layer, its backdrop snapshot when it composites with its mode, else null. */
  snapshots: readonly (BackdropSnapshot | null)[];
  /** V35-K4: the layer records buffer, which the snapshot records sit in. */
  records: GPUBuffer;
}>;

type MaskSourceDraw = Readonly<{ instance: number; firstTriangle: number; triangleCount: number }> &
  MeshCoverage;

/** U4: the mesh source draws of the clip part's mask levels, for the mesh part's checks. */
function maskSourceDraws(packet: PrimitivePacket): MaskSourceDraw[] {
  const masks: unknown = packet.clip?.masks;
  if (!Array.isArray(masks)) return [];
  const draws: MaskSourceDraw[] = [];
  for (const level of masks as readonly ClipMaskPacketLevel[]) {
    const source: unknown = level?.source;
    if (typeof source !== 'object' || source === null) continue;
    const mesh = source as Partial<Extract<ClipMaskPacketLevel['source'], { kind: 'mesh' }>>;
    if (mesh.kind === 'mesh' && typeof mesh.draw === 'object' && mesh.draw !== null) {
      draws.push(mesh.draw);
    }
  }
  return draws;
}

/** U4: a primitive source names a written slot; a mesh source names a node and a checked draw. */
function validMaskSource(source: unknown, validated: ValidatedPacket): boolean {
  if (typeof source !== 'object' || source === null) return false;
  const value = source as Partial<{ kind: unknown; slot: unknown; nodeId: unknown; draw: unknown }>;
  if (value.kind === 'primitive') {
    const slot = value.slot;
    return (
      typeof slot === 'number' &&
      Number.isSafeInteger(slot) &&
      validated.initialized.transforms.has(slot) &&
      validated.initialized.geometry.has(slot) &&
      validated.initialized.styles.has(slot)
    );
  }
  return (
    value.kind === 'mesh' && typeof value.nodeId === 'string' && typeof value.draw === 'object'
  );
}

type ValidatedMesh =
  | Readonly<{ skipped: true }>
  | Readonly<{
      skipped: false;
      /** Null for a part that carries notices only. */
      arena: MeshArenaState | null;
      createdArena: boolean;
      instances: ReadonlySet<number>;
      links: ReadonlyMap<number, number>;
      frameInitialized: boolean;
      draws: readonly MeshFillDraw[];
      receiptResources: readonly MeshReceiptResource[];
    }>;

interface ValidatedPacket {
  readonly arena: ArenaState;
  readonly createdArena: boolean;
  readonly initialized: ArenaState['initialized'];
  readonly order: ReadonlyMap<number, number>;
  readonly frameInitialized: boolean;
  readonly receiptResources: PrimitiveReceipt['resources'];
}

/** E25 U3: the layers part's layer entries, or none without the part; a malformed part throws. */
function packetLayers(packet: PrimitivePacket): LayerPacketPart['layers'] {
  const part = packet.layers as Partial<LayerPacketPart> | null | undefined;
  if (part === undefined) return [];
  if (
    typeof part !== 'object' ||
    part === null ||
    part.layoutVersion !== 0 ||
    !isArrayValue(part.layers) ||
    !isArrayValue(part.composites) ||
    !isArrayValue(part.notices)
  ) {
    throw new TypeError('Invalid layers part.');
  }
  for (const layer of part.layers as readonly unknown[]) {
    const value = layer as Partial<LayerPacketPart['layers'][number]> | null;
    if (
      typeof value !== 'object' ||
      value === null ||
      !isArrayValue(value.draws) ||
      !isArrayValue(value.meshDraws)
    ) {
      throw new TypeError('Invalid layer.');
    }
  }
  return part.layers;
}

function isNativeCanvasContext(
  context: WebGpuCanvasContextPort,
): context is NativeCanvasContextPort {
  return 'native' in context;
}

function align(value: number, alignment: number): number {
  const remainder = value % alignment;
  return remainder === 0 ? value : value + alignment - remainder;
}

function nextPowerOfTwo(value: number): number {
  let result = 1;
  while (result < value) result *= 2;
  return result;
}

function safeLimit(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function copyTarget(target: PrimitiveTarget): PrimitiveTarget {
  return Object.freeze({ ...target });
}

function targetEquals(left: PrimitiveTarget, right: PrimitiveTarget): boolean {
  return (
    left.generation === right.generation &&
    left.surfaceRevision === right.surfaceRevision &&
    left.width === right.width &&
    left.height === right.height &&
    left.devicePixelRatio === right.devicePixelRatio &&
    left.sampleCount === right.sampleCount &&
    left.targetFormat === right.targetFormat
  );
}

/** E41 U5: the intersection of two device rectangles, or null when empty; `b` null is no bound. */
function intersectRects(a: DeviceRect | null, b: DeviceRect | null): DeviceRect | null {
  if (a === null) return null;
  if (b === null) return a;
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const bottom = Math.min(a.y + a.height, b.y + b.height);
  return right > x && bottom > y ? { x, y, width: right - x, height: bottom - y } : null;
}

/** E41 U5: a layer's effect record as section 5.2 and K4 bound it; throws otherwise. */
function validateEffectRecord(effect: LayerEffectRecord): void {
  const rect = (value: unknown) => {
    const box = value as Partial<DeviceRect> | null;
    return (
      typeof box === 'object' &&
      box !== null &&
      Number.isSafeInteger(box.x) &&
      Number.isSafeInteger(box.y) &&
      isPositiveSafeInteger(box.width!) &&
      isPositiveSafeInteger(box.height!)
    );
  };
  const sigma = (value: unknown) =>
    typeof value === 'number' && value >= 0 && value <= E41_SIGMA_PX_MAX;
  const unit = (value: unknown) => typeof value === 'number' && value >= 0 && value <= 1;
  if (
    typeof effect !== 'object' ||
    effect === null ||
    !rect(effect.source) ||
    !rect(effect.output) ||
    !Array.isArray(effect.shadows) ||
    effect.shadows.length > 8 ||
    !(effect.shadows as readonly unknown[]).every((value) => {
      const shadow = value as Partial<LayerEffectRecord['shadows'][number]> | null;
      const color = shadow?.color as Partial<LayerEffectRecord['shadows'][number]['color']> | null;
      return (
        typeof shadow === 'object' &&
        shadow !== null &&
        Number.isFinite(shadow.dx) &&
        Number.isFinite(shadow.dy) &&
        sigma(shadow.sigmaPx) &&
        typeof color === 'object' &&
        color !== null &&
        [color.r, color.g, color.b, color.a].every(unit)
      );
    }) ||
    !(effect.blurSigmaPx === null || sigma(effect.blurSigmaPx)) ||
    typeof effect.contentOpacity !== 'number' ||
    !(effect.contentOpacity > 0 && effect.contentOpacity <= 1)
  ) {
    throw new Error('Invalid layer effect.');
  }
}

function isPositiveSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

function isPowerOfTwo(value: number): boolean {
  return isPositiveSafeInteger(value) && Math.log2(value) % 1 === 0;
}

function isArrayValue(value: unknown): value is readonly unknown[] {
  return Array.isArray(value);
}

function asError(value: unknown, message: string): Error {
  return value instanceof Error ? value : new Error(message, { cause: value });
}

function frozenResult(
  reason: 'invalid-packet' | 'allocation-failed' | 'submission-failed',
): PrimitiveSubmitResult {
  return Object.freeze({ status: 'failed' as const, reason });
}

class NativePrimitiveScene implements WebGpuPrimitiveScenePort {
  readonly shaderModulesCreated: number;
  readonly pipelinesCreated: number;
  readonly meshPipelineAvailable: boolean;
  readonly clipPipelineAvailable: boolean;
  readonly sampleCount: 1 | 4;
  readonly #device: GPUDevice;
  readonly #context: NativeCanvasContextPort;
  readonly #format: PrimitiveTargetFormat;
  readonly #generation: number;
  readonly #resources: WebGpuResourceTracker;
  readonly #pipelineCache: PipelineCache<GPURenderPipeline>;
  readonly #pipeline: GPURenderPipeline;
  readonly #bindGroupLayout: GPUBindGroupLayout;
  readonly #vertexBuffer: GPUBuffer;
  readonly #indexBuffer: GPUBuffer;
  readonly #staticResourceIds: readonly string[];
  #target: PrimitiveTarget | null = null;
  #attachment: GPUTexture | undefined;
  #attachmentId: string | undefined;
  /**
   * E17 contract, section 3: a generation created with the mesh pipeline option draws in a pass
   * with this write-once stencil attachment (`stencil8`, the scene's sample count).
   */
  readonly #stencil: boolean;
  #stencilAttachment: GPUTexture | undefined;
  #stencilAttachmentId: string | undefined;
  #currentArena: ArenaState | undefined;
  readonly #mesh: MeshPipelineState | null;
  /** E10 contract, section 5: the count pipelines, created only with the countPass option. */
  readonly #count: CountPipelineState | null;
  /** E10 contract, section 4: the capture armed for the next submission. */
  #capture: WebGpuSceneCaptureRequestForTesting | undefined;
  #nextCapture = 1;
  /** The capture of a captured submission until it settles; failed on dispose. */
  #inFlight: PendingCapture | null = null;
  #currentMeshArena: MeshArenaState | undefined;
  readonly #clip: ClipPipelineState | null;
  #clipBuffer: ClipBufferState | undefined;
  #nextClipBuffer = 1;
  /** @internal Tests only (P4-A06): state records written to the clip buffer so far. */
  public clipStateWritesForTesting = 0;
  /**
   * E30-U5 (L3b): the last frame's packed bytes per clip state index, kept for a record that is
   * the same deeply frozen object under the same origin and mask level offset, so an unchanged
   * state is not packed again and its change-only write compares by identity.
   */
  #packedClipStates = new Map<number, PackedClipState>();
  #reusePackedClipStates = true;
  /** @internal Tests only (E30-U5 L3b): clip state bytes counted as reused, and the twin's switch. */
  public reusedClipStatesForTesting = 0;
  public disableClipStateReuseForTesting(): void {
    this.#reusePackedClipStates = false;
    this.#packedClipStates.clear();
  }
  readonly paintPipelineAvailable: boolean;
  readonly #paint: PaintPipelineState | null;
  readonly layerPipelineAvailable: boolean;
  readonly #layer: LayerPipelineState | null;
  /** E25 section 4: the layer tile edge, `layerTileSizeForTesting` or 1024. */
  readonly #layerTileSize: number;
  #nextLayerFrame = 1;
  #layerPasses = 0;
  /** E41 U5: true when the effect pipelines exist; effect roots then draw with their effects. */
  readonly effectPipelineAvailable: boolean;
  readonly #effect: EffectPipelineState | null;
  /** @internal Tests only (E41-A05): effect roots composite `L`, without their effects. */
  readonly #effectContentForTesting: boolean;
  #effectPasses = 0;
  /** V35-K7: true when the backdrop snapshot and blend composite pipelines exist. */
  readonly blendPipelineAvailable: boolean;
  readonly #blend: BlendPipelineState | null;
  /** V35-K8: backdrop splits so far (one per end-and-resume of a pass around a snapshot). */
  #blendSplits = 0;
  readonly textPipelineAvailable: boolean;
  readonly #text: TextPipelineState | null;
  /** E28 section 4, Atlas pages: index i holds page i, as the packet's `pageCount` asks. */
  #textPages: TextPage[] = [];
  #nextTextPage = 1;
  #textBuffer: TextBufferState | undefined;
  #nextTextBuffer = 1;
  /**
   * E28-D1: set when a page or the text buffer could not be created, or the records exceed the
   * buffer limits; text stays undrawn for the generation, and
   * the text receipt reports the stable placeholder incarnations below so the plan settles.
   */
  #textPageAllocationFailed = false;
  readonly #textPlaceholders: symbol[] = [];
  #paintBuffers: PaintBufferState | undefined;
  #nextPaintBuffer = 1;
  /** Packed bytes per record object; renderer-core keeps a record object while it is unchanged. */
  #paintRecordBytes = new WeakMap<GradientPaintRecord, Uint8Array>();
  /** @internal Tests only (E23-A05): gradient records written to the record table so far. */
  public paintRecordWritesForTesting = 0;
  /** U4 (Mask cache): the mask textures, by mask container id. */
  readonly #masks = new Map<string, MaskEntry>();
  #nextMask = 1;
  #nextTileSet = 1;
  #maskPasses = 0;
  #retiredArenas: ArenaBase[] = [];
  #nextArenaId = 1;
  #nextSubmissionSerial = 1;
  #latestSubmittedSerial = 0;
  #completionObserverPending = false;
  #disposed = false;

  public constructor(
    device: GPUDevice,
    context: NativeCanvasContextPort,
    format: PrimitiveTargetFormat,
    generation: number,
    sampleCount: 1 | 4,
    pipelineCache: PipelineCache<GPURenderPipeline>,
    pipeline: GPURenderPipeline,
    bindGroupLayout: GPUBindGroupLayout,
    vertexBuffer: GPUBuffer,
    indexBuffer: GPUBuffer,
    resources: WebGpuResourceTracker,
    staticResourceIds: readonly string[],
    mesh: MeshPipelineState | null = null,
    meshShaderModulesCreated = 0,
    count: CountPipelineState | null = null,
    stencil = false,
    clip: ClipPipelineState | null = null,
    paint: PaintPipelineState | null = null,
    layer: LayerPipelineState | null = null,
    layerTileSize: number = E25_LAYER_TILE_SIZE,
    text: TextPipelineState | null = null,
    effect: EffectPipelineState | null = null,
    effectContentForTesting = false,
    blend: BlendPipelineState | null = null,
  ) {
    this.#blend = blend;
    this.blendPipelineAvailable = blend !== null;
    this.#effect = effect;
    this.effectPipelineAvailable = effect !== null;
    this.#effectContentForTesting = effectContentForTesting;
    this.#text = text;
    this.textPipelineAvailable = text !== null;
    this.#layerTileSize = layerTileSize;
    this.#layer = layer;
    this.layerPipelineAvailable = layer !== null;
    this.#mesh = mesh;
    this.#clip = clip;
    this.clipPipelineAvailable = clip !== null;
    this.#paint = paint;
    this.paintPipelineAvailable = paint !== null;
    this.#count = count;
    this.#stencil = stencil;
    this.meshPipelineAvailable = mesh !== null;
    // E10 contract, section 5: one count module (two at 4x, with the readout) and two count
    // pipelines (three at 4x); none without the countPass option. E17 section 3: the mesh path
    // adds the reset pipeline, and the count pass its own reset pipeline over the same module.
    const countModules = count === null ? 0 : count.readout === null ? 1 : 2;
    // P4 contract, U3 and U4: the clip and mask modules (two, four with the mesh path) and
    // pipelines (two, five with the mesh path); none without the clipPipeline option.
    const clipModules = clip === null ? 0 : clip.mesh === null ? 2 : 4;
    // E23 contract, U3: the paint modules (analytic and mesh, each also with the clip block)
    // and pipelines (analytic, and fill and joint for the mesh module); none without the
    // paintPipeline option.
    const paintModules =
      paint === null
        ? 0
        : (1 + (paint.mesh === null ? 0 : 1)) * (paint.analyticClip === null ? 1 : 2);
    // E25 contract, U3: the composite module and one layer module per position-reading module
    // (the clip and paint ones, and the plain mesh module); none without the layerPipeline
    // option. Each mesh layer module has a fill and a joint pipeline.
    const analyticLayerModules =
      layer === null
        ? 0
        : [layer.analyticClip, layer.analyticPaint, layer.analyticPaintClip].filter(
            (pipeline) => pipeline !== null,
          ).length;
    const meshLayerModules =
      layer === null
        ? 0
        : [layer.mesh, layer.meshClip, layer.meshPaint, layer.meshPaintClip].filter(
            (pipeline) => pipeline !== null,
          ).length;
    const layerModules = layer === null ? 0 : 1 + analyticLayerModules + meshLayerModules;
    // E28 contract, U3: one module and one pipeline per text variant (plain, and the clip,
    // layer and combined ones the generation has); none without the textPipeline option.
    const textVariants =
      text === null
        ? 0
        : [text.plain, text.clip, text.layer, text.clipLayer].filter(
            (pipeline) => pipeline !== null,
          ).length;
    this.shaderModulesCreated =
      1 +
      meshShaderModulesCreated +
      countModules +
      clipModules +
      paintModules +
      layerModules +
      textVariants +
      (effect === null ? 0 : 1 + effect.shifted.modules);
    this.pipelinesCreated =
      // E39-R8: with the mesh path, four stencil pass pipelines per target (two plain, two
      // joint) and seven covers per mesh variant (two rules, five joint covers; plain, clip,
      // paint, layer) and in the count pass; the mask pass has one stencil and two covers.
      (mesh === null ? 1 : 15) +
      (count === null ? 0 : countModules + 13) +
      (clip === null ? 0 : clip.mesh === null ? 2 : 15) +
      (paint === null
        ? 0
        : (1 + (paint.mesh === null ? 0 : 9)) * (paint.analyticClip === null ? 1 : 2)) +
      (layer === null ? 0 : 1 + analyticLayerModules + 9 * meshLayerModules) +
      textVariants +
      (effect === null ? 0 : EFFECT_PASS_KINDS.length + effect.shifted.count);
    this.#device = device;
    this.#context = context;
    this.#format = format;
    this.#generation = generation;
    this.sampleCount = sampleCount;
    this.#pipelineCache = pipelineCache;
    this.#pipeline = pipeline;
    this.#bindGroupLayout = bindGroupLayout;
    this.#vertexBuffer = vertexBuffer;
    this.#indexBuffer = indexBuffer;
    this.#resources = resources;
    this.#staticResourceIds = staticResourceIds;
  }

  public setTarget(target: PrimitiveTarget): void {
    this.#requireActive();
    if (
      target.generation !== this.#generation ||
      target.sampleCount !== this.sampleCount ||
      target.targetFormat !== this.#format ||
      !isPositiveSafeInteger(target.surfaceRevision) ||
      !Number.isSafeInteger(target.width) ||
      target.width < 0 ||
      !Number.isSafeInteger(target.height) ||
      target.height < 0 ||
      !Number.isFinite(target.devicePixelRatio) ||
      target.devicePixelRatio <= 0
    ) {
      throw new RangeError('Primitive target does not match the native scene.');
    }
    const previous = this.#target;
    if (
      previous !== null &&
      previous.width === target.width &&
      previous.height === target.height &&
      previous.sampleCount === target.sampleCount
    ) {
      this.#target = copyTarget(target);
      return;
    }
    // P4 section 4, Resources: a resize releases the mask textures, best effort, so a release
    // error never leaves the target stale.
    try {
      this.#releaseMasks();
    } catch {
      // Accounting cleanup is best effort.
    }
    if (target.width === 0 || target.height === 0) {
      this.#releaseAttachment();
      this.#target = copyTarget(target);
      return;
    }
    // E17 contract, section 3: the stencil attachment follows the target at 1x and 4x. Both
    // attachments are created and tracked before either replaces the current one, so a failure
    // leaves the previous, consistent pair.
    const stencil = this.#stencil ? this.#createStencilAttachment(target) : undefined;
    if (this.sampleCount === 1) {
      this.#releaseColorAttachment();
      if (stencil !== undefined) this.#commitStencilAttachment(stencil);
      this.#target = copyTarget(target);
      return;
    }
    const id = `primitive/${this.#generation}/attachment-${target.surfaceRevision}`;
    let attachment: GPUTexture;
    try {
      attachment = this.#device.createTexture({
        label: id,
        size: { width: target.width, height: target.height },
        sampleCount: this.sampleCount,
        format: this.#format,
        // V35-K4: under blend 'v0' the backdrop snapshot reads the attachment.
        usage: RENDER_ATTACHMENT_USAGE | (this.#blend === null ? 0 : TEXTURE_BINDING_USAGE),
      });
    } catch (error) {
      if (stencil !== undefined) this.#discardStencilAttachment(stencil);
      throw asError(error, 'Primitive attachment creation failed.');
    }
    try {
      this.#resources.track(id, {
        category: 'texture',
        dimension: '2d',
        width: target.width,
        height: target.height,
        depthOrArrayLayers: 1,
        mipLevelCount: 1,
        sampleCount: this.sampleCount,
        bytesPerTexel: 4,
      });
    } catch (error) {
      attachment.destroy();
      if (stencil !== undefined) this.#discardStencilAttachment(stencil);
      throw asError(error, 'Primitive attachment accounting failed.');
    }
    if (stencil !== undefined) this.#commitStencilAttachment(stencil);
    const previousAttachment = this.#attachment;
    const previousAttachmentId = this.#attachmentId;
    this.#attachment = attachment;
    this.#attachmentId = id;
    this.#target = copyTarget(target);
    let releaseError: unknown;
    try {
      previousAttachment?.destroy();
    } catch (error) {
      releaseError = error;
    }
    if (previousAttachmentId !== undefined) this.#resources.release(previousAttachmentId);
    if (releaseError !== undefined)
      throw asError(releaseError, 'Previous attachment release failed.');
  }

  /** @internal Tests only (E10 contract, section 4). */
  public captureNextSubmissionForTesting(request: WebGpuSceneCaptureRequestForTesting): void {
    if (this.#capture !== undefined) {
      request.reject(new CaptureError('capture-pending', 'a capture is already armed'));
      return;
    }
    if (request.counts && this.#count === null) {
      request.reject(new CaptureError('capture-disabled', 'no count pipelines'));
      return;
    }
    this.#capture = request;
  }

  public submitPrimitivePacket(packet: PrimitivePacket): PrimitiveSubmitResult {
    const request = this.#capture;
    this.#capture = undefined;
    if (request === undefined) return this.#submit(packet, null);
    const target = this.#target;
    if (target !== null && (target.width === 0 || target.height === 0)) {
      // Nothing to copy; the product frame still goes through as without a capture.
      request.reject(new CaptureError('no-submission', 'zero-size target'));
      return this.#submit(packet, null);
    }
    const capture: PendingCapture = new PendingCapture(request, this.#resources, () => {
      if (this.#inFlight === capture) this.#inFlight = null;
    });
    this.#inFlight = capture;
    const result = this.#submit(packet, capture);
    if (result.status === 'submitted') capture.submitted();
    else capture.fail(new CaptureError('no-submission', `submission ${result.status}`));
    return result;
  }

  #submit(packet: PrimitivePacket, capture: PendingCapture | null): PrimitiveSubmitResult {
    if (this.#disposed || this.#target === null) return Object.freeze({ status: 'not-ready' });
    if (packet.generation !== this.#generation) {
      return Object.freeze({ status: 'stale-generation' });
    }

    let validated: ValidatedPacket;
    try {
      validated = this.#preflight(packet);
    } catch (error) {
      return frozenResult(
        error instanceof AllocationError ? 'allocation-failed' : 'invalid-packet',
      );
    }

    const { arena } = validated;
    // E25 U3: #preflight has checked the part's shape.
    const layerEntries = packetLayers(packet);
    let mesh: ValidatedMesh | null = null;
    if (packet.mesh === undefined && layerEntries.some((layer) => layer.meshDraws.length > 0)) {
      if (validated.createdArena) this.#releaseArena(arena);
      return frozenResult('invalid-packet');
    }
    if (packet.mesh !== undefined) {
      try {
        mesh = this.#preflightMesh(
          packet.mesh,
          packet.draws.length,
          maskSourceDraws(packet),
          layerEntries.map((layer) => ({
            draws: layer.meshDraws,
            analyticDraws: layer.draws.length,
          })),
        );
      } catch (error) {
        if (validated.createdArena) this.#releaseArena(arena);
        return frozenResult(
          error instanceof AllocationError ? 'allocation-failed' : 'invalid-packet',
        );
      }
    }
    const meshArena = mesh !== null && !mesh.skipped ? mesh.arena : null;
    const meshDraws = mesh !== null && !mesh.skipped ? mesh.draws : [];
    // E25 U3: a layer's mesh draws are drawn exactly when the main pass's are.
    const layerMeshDraws = layerEntries.map((layer) =>
      mesh !== null && !mesh.skipped ? layer.meshDraws : [],
    );
    const analyticDraws = [...packet.draws, ...layerEntries.flatMap((layer) => layer.draws)];
    const allMeshDraws = [...meshDraws, ...layerMeshDraws.flat()];
    let paint: ValidatedPaint;
    let clip: ValidatedClip;
    let layers: ValidatedLayers;
    let slots: ReadonlyMap<number, readonly OrderSlot[]>;
    let text: ValidatedText;
    try {
      // E23 U3: checks and packs only; the paint buffers are created and written below.
      paint = this.#preflightPaint(packet, analyticDraws, allMeshDraws, validated);
      // E28 section 4: composites and text draws by (position, order), per target.
      slots = orderSlots(packet);
      // E28 U3: checks only; pages and the text buffer are created and written below.
      text = this.#preflightText(packet);
      // E28-K8: a text draw's clip state is checked as any draw's.
      clip = this.#preflightClip(
        packet,
        // E41-K2b: an effect root's composite state too.
        [...analyticDraws, ...(text?.part.draws ?? []), ...(packet.layers?.composites ?? [])],
        allMeshDraws,
        validated,
      );
      layers = this.#preflightLayers(packet, layerEntries, layerMeshDraws, slots);
    } catch (error) {
      if (validated.createdArena) this.#releaseArena(arena);
      if (mesh !== null && !mesh.skipped && mesh.createdArena && mesh.arena !== null) {
        this.#releaseArena(mesh.arena);
      }
      return frozenResult(
        error instanceof AllocationError ? 'allocation-failed' : 'invalid-packet',
      );
    }
    // U4: the mask passes' transient attachments, released after the submission.
    const transients: Transient[] = [];
    // U4: once submitted, created mask entries belong to the cache and are not discarded.
    let submittedWork = false;
    // E28 U3: the text receipt part, and whether the frame's text draws are encoded.
    let textReceipt: TextReceiptPart | undefined;
    let textDrawable = false;
    try {
      // E23 section 4, Resources: a frame without a drawn gradient draw releases the paint
      // buffers, so a scene whose gradients are all gone returns to the solid baseline.
      if (paint !== null) this.#writePaint(paint);
      else this.#releasePaintBuffers();
      if (clip !== null) this.#writeClip(clip);
      // P4 section 4, Resources: a frame with no clip part releases the clip buffer, so a scene
      // whose clips are all gone returns to the unclipped accounting baseline.
      else if (packet.clip === undefined) this.#releaseClipBuffer();
      // E28 section 4, Lifetime: pages follow `pageCount`; clears, then uploads, before the
      // passes. A packet without a text part holds no page, so pages and buffer are released.
      if (text !== null) {
        textReceipt = this.#applyText(text);
        textDrawable = this.#textBuffer !== undefined && !this.#textPageAllocationFailed;
      } else {
        this.#releaseTextPages();
        this.#releaseTextBuffer();
      }
      for (const write of packet.writes) {
        const allocation = arena.allocations[write.resourceId];
        this.#device.queue.writeBuffer(
          arena.buffer,
          allocation.offset + write.byteOffset,
          write.bytes,
          0,
          write.bytes.byteLength,
        );
      }
      if (meshArena !== null) {
        for (const write of packet.mesh!.writes) {
          const allocation = meshArena.allocations[write.resourceId];
          this.#device.queue.writeBuffer(
            meshArena.buffer,
            allocation.offset + write.byteOffset,
            write.bytes,
            0,
            write.bytes.byteLength,
          );
        }
      }

      if (!Number.isSafeInteger(this.#nextSubmissionSerial)) {
        throw new Error('Primitive submission serial exhausted.');
      }
      const presentation = this.#context.native.getCurrentTexture();
      const presentationView = presentation.createView();
      const multisampleView = this.#attachment?.createView();
      const encoder = this.#device.createCommandEncoder({ label: 'vector-studio/primitive-frame' });
      if (clip !== null) {
        this.#encodeMaskPasses(encoder, clip, arena, meshArena, transients);
      }
      // E25 section 4, Pass order: the layers in post-order, after the mask passes.
      const layerFrame =
        layers === null
          ? null
          : this.#encodeLayerPasses(encoder, layers, arena, meshArena, clip, paint, transients, {
              part: textDrawable ? text!.part : null,
            });
      const stencilView = this.#stencilAttachment?.createView();
      // V35-K4: the main pass's splits. Each segment before the last stores colour and stencil
      // (and resolves nothing); a resumed one loads them. Without splits the pass is encoded
      // exactly as before (V35-A06).
      const mainSplits = layerFrame === null ? undefined : layers!.splits.get('-1');
      let remainingSplits = mainSplits?.size ?? 0;
      const beginMain = (resume: boolean) => {
        const last = remainingSplits === 0;
        return encoder.beginRenderPass({
          label: 'vector-studio/primitive-pass',
          colorAttachments: [
            {
              view: multisampleView ?? presentationView,
              ...(multisampleView === undefined || !last
                ? {}
                : { resolveTarget: presentationView }),
              clearValue: { r: 0, g: 0, b: 0, a: 1 },
              loadOp: resume ? 'load' : 'clear',
              storeOp: multisampleView === undefined || !last ? 'store' : 'discard',
            },
          ],
          // E17 contract, section 3: cleared to 0 each frame, not stored (V35-K4: stored and
          // loaded again across a split).
          ...(stencilView === undefined
            ? {}
            : {
                depthStencilAttachment: {
                  view: stencilView,
                  stencilClearValue: 0,
                  stencilLoadOp: resume ? 'load' : 'clear',
                  stencilStoreOp: last ? 'discard' : 'store',
                },
              }),
        });
      };
      let pass = beginMain(false);
      const mainParent: BackdropParent | null =
        mainSplits === undefined || this.#blend === null
          ? null
          : Object.freeze({
              pipeline: this.#blend.snapshot,
              bindGroup: this.#device.createBindGroup({
                label: 'vector-studio/backdrop-main-parent',
                layout: this.#blend.snapshotBindGroupLayout,
                entries: [
                  {
                    binding: BACKDROP_SNAPSHOT_BINDINGS.parent,
                    resource: multisampleView ?? presentationView,
                  },
                  {
                    binding: BACKDROP_SNAPSHOT_BINDINGS.record,
                    resource: {
                      buffer: layerFrame!.records,
                      offset: 0,
                      size: BACKDROP_SNAPSHOT_RECORD_SIZE,
                    },
                  },
                ],
              }),
              region: { x: 0, y: 0, width: this.#target.width, height: this.#target.height },
            });
      // P4 contract, U3: a clipped draw uses its pipeline's clip variant, with the clip bind
      // group at its state's dynamic offset; a draw without a clip state is encoded exactly as
      // before. Without the clip variants a clipped draw is not drawn (fail closed).
      // U4: a state under a mask level binds that level's bind group, which holds its texture.
      const clipPipelines = clip === null ? null : this.#clip;
      // E23 contract, U3: a draw with a gradient paint uses its pipeline's paint variant; each
      // switch to a paint variant binds group 2 (the analytic or mesh paint group) and, without
      // a clip, the empty group 1. Without the paint variants a gradient draw is not drawn
      // (fail closed); a draw with only solid paints is encoded exactly as before.
      const paintPipelines = paint === null ? null : this.#paint;
      const paintBuffers = paint === null ? null : this.#paintBuffers!;
      let clipBoundState = 0;
      const bindClip = (state: number) => {
        if (state === clipBoundState) return;
        pass.setBindGroup(CLIP_BIND_GROUP_INDEX, this.#clipBindGroup(clip!, state), [
          state * clip!.stride,
        ]);
        clipBoundState = state;
      };
      const bindPaint = (group: GPUBindGroup, clipped: boolean) => {
        if (!clipped) {
          pass.setBindGroup(CLIP_BIND_GROUP_INDEX, paintPipelines!.emptyBindGroup);
          clipBoundState = 0;
        }
        pass.setBindGroup(PAINT_BIND_GROUP_INDEX, group);
      };
      const bindAnalytic = (pipeline: GPURenderPipeline) => {
        pass.setPipeline(pipeline);
        pass.setBindGroup(0, arena.bindGroup);
        pass.setVertexBuffer(0, this.#vertexBuffer, 0, 32);
        pass.setIndexBuffer(this.#indexBuffer, 'uint16', 0, 12);
        clipBoundState = 0;
      };
      bindAnalytic(this.#pipeline);
      // P3 V3 section g: draws are encoded in merged paint order; the pipeline and bind group
      // switch only at a variant change.
      // ST-U7 addendum, section 4.5: a joint fill draw switches to the joint pipeline and the
      // next plain mesh draw back; the mesh bind group is shared.
      // E17 contract, section 3: every mesh draw sets its write-once reference; a reset draw
      // clears the stencil before the references repeat.
      // The bound pipeline: an analytic or mesh kind, or null after a reset draw, whose
      // pipeline has no bind group, so the next mesh draw binds its pipeline and group 0.
      let bound: string | null = 'analytic';
      let nextMeshDraw = 0;
      // E39-R5: partition draws take E17 ordinals; winding and union draws take none.
      const sequence = new MeshStencilSequence();
      // E28 section 4 (E25 U3): at each position, slot k holds the composite or text draw whose
      // order is k, otherwise the next mesh draw. A composite or text draw binds its own groups,
      // so the next draw binds its pipeline and groups again.
      const mainSlots = slots.get(-1) ?? [];
      let nextSlot = 0;
      const drawSlot = (slot: OrderSlot) => {
        if (slot.text !== null) {
          if (!textDrawable) return;
          const draw = text!.part.draws[slot.text]!;
          const state = draw.clipState ?? 0;
          const pipeline = state === 0 ? this.#text!.plain : this.#text!.clip;
          if (pipeline === null || (state !== 0 && clipPipelines === null)) return;
          pass.setPipeline(pipeline);
          pass.setBindGroup(0, this.#textBindGroup(draw.page));
          if (state !== 0) {
            pass.setBindGroup(CLIP_BIND_GROUP_INDEX, this.#clipBindGroup(clip!, state), [
              state * clip!.stride,
            ]);
          }
          pass.draw(6, draw.count, 0, draw.first);
          bound = null;
          clipBoundState = 0;
          return;
        }
        if (slot.layer === null || layerFrame === null) return;
        const planned = mainSplits?.get(slot.layer);
        const snapshot = layerFrame.snapshots[slot.layer];
        if (planned !== undefined && mainParent !== null && snapshot != null) {
          // V35-K4: end the pass, copy the backdrop under the root's composite, resume.
          pass.end();
          remainingSplits -= 1;
          snapshotBackdrop(
            encoder,
            mainParent,
            planned.rect,
            0,
            snapshot,
            planned.record * layers!.stride,
          );
          pass = beginMain(true);
        }
        const state = this.#encodeComposite(pass, layerFrame, slot.layer, 0, clip);
        bound = null;
        // -1 (nothing drawn) is no state, so the next clipped draw binds its group.
        clipBoundState = state;
      };
      const drawMeshesAt = (position: number) => {
        let order = 0;
        for (;;) {
          const slot = mainSlots[nextSlot];
          if (slot !== undefined && slot.position === position && slot.order === order) {
            drawSlot(slot);
            nextSlot += 1;
            order += 1;
            continue;
          }
          if (meshDraws[nextMeshDraw]?.position !== position) break;
          order += 1;
          const draw = meshDraws[nextMeshDraw]!;
          const coverage = draw.coverage;
          const joint = coverage === undefined && draw.composite === 'joint-fill';
          const state = draw.clipState ?? 0;
          const step = coverage === undefined ? sequence.partition() : null;
          nextMeshDraw += 1;
          if (step === null ? sequence.winding() : step.reset) {
            pass.setPipeline(this.#mesh!.resetPipeline);
            pass.draw(3);
            bound = null;
          }
          // E39-R6: a joint draw's stroke draw follows it (checked at validation); the pair
          // draws as one through the stencil's two halves.
          const jointStroke =
            coverage !== undefined && draw.composite === 'joint-fill'
              ? meshDraws[nextMeshDraw]!
              : null;
          if (jointStroke !== null) {
            nextMeshDraw += 1;
            order += 1;
          }
          if (state !== 0 && (clipPipelines?.mesh ?? null) === null) continue;
          const painted =
            draw.gradient !== undefined ||
            draw.strokeGradient !== undefined ||
            jointStroke?.gradient !== undefined;
          if (jointStroke !== null) {
            const covers = painted
              ? state === 0
                ? (paintPipelines?.meshCover ?? null)
                : (paintPipelines?.meshCoverClip ?? null)
              : state === 0
                ? this.#mesh!.cover
                : clipPipelines!.meshCover;
            if (covers === null) continue;
            // encodeMeshJoint sets each step's pipeline; group 0 may be set before it.
            if (bound === null || bound.startsWith('analytic')) {
              pass.setBindGroup(0, meshArena!.bindGroup);
              clipBoundState = 0;
            }
            encodeMeshJoint(
              pass,
              draw,
              jointStroke,
              meshCoverRule(draw),
              (kind) => this.#mesh!.stencil[kind],
              (cover) => covers[cover],
              () => {
                if (painted) bindPaint(paintBuffers!.meshBindGroup, state !== 0);
                if (state !== 0) bindClip(state);
              },
            );
            // The next mesh draw sets its pipeline and paint group again.
            bound = 'joint-cover';
            continue;
          }
          if (coverage !== undefined) {
            // E39-R1, R2: the stencil triangles with no color, then the cover quad under the
            // rule's stencil test, which zeroes every sample it tests.
            const rule = meshCoverRule(draw);
            const covers = painted
              ? state === 0
                ? (paintPipelines?.meshCover ?? null)
                : (paintPipelines?.meshCoverClip ?? null)
              : state === 0
                ? this.#mesh!.cover
                : clipPipelines!.meshCover;
            if (covers === null) continue;
            const stencilTriangles = draw.triangleCount - 2;
            pass.setPipeline(this.#mesh!.stencil[coverage]);
            if (bound === null || bound.startsWith('analytic')) {
              pass.setBindGroup(0, meshArena!.bindGroup);
              clipBoundState = 0;
            }
            pass.setStencilReference(meshStencilPassReference(coverage));
            pass.draw(3 * stencilTriangles, 1, 3 * draw.firstTriangle, draw.instance);
            const kind = `cover-${rule}${painted ? '+paint' : ''}${state !== 0 ? '+clip' : ''}`;
            const switched = bound !== kind;
            pass.setPipeline(covers[rule]);
            if (painted && switched) bindPaint(paintBuffers!.meshBindGroup, state !== 0);
            bound = kind;
            if (state !== 0) bindClip(state);
            pass.setStencilReference(0);
            pass.draw(6, 1, 3 * (draw.firstTriangle + stencilTriangles), draw.instance);
            continue;
          }
          const paintPipeline = !painted
            ? null
            : state === 0
              ? joint
                ? (paintPipelines?.meshJoint ?? null)
                : (paintPipelines?.mesh ?? null)
              : joint
                ? (paintPipelines?.meshJointClip ?? null)
                : (paintPipelines?.meshClip ?? null);
          if (painted && paintPipeline === null) continue;
          const kind = `${joint ? 'joint' : 'fill'}${painted ? '+paint' : ''}${state !== 0 ? '+clip' : ''}`;
          const pipeline =
            paintPipeline ??
            (state === 0
              ? joint
                ? this.#mesh!.jointPipeline
                : this.#mesh!.pipeline
              : joint
                ? clipPipelines!.meshJoint!
                : clipPipelines!.mesh!);
          const switched = bound !== kind;
          if (bound === null || bound.startsWith('analytic')) {
            pass.setPipeline(pipeline);
            pass.setBindGroup(0, meshArena!.bindGroup);
            clipBoundState = 0;
          } else if (bound !== kind) {
            pass.setPipeline(pipeline);
          }
          if (painted && switched) bindPaint(paintBuffers!.meshBindGroup, state !== 0);
          bound = kind;
          if (state !== 0) bindClip(state);
          pass.setStencilReference(step!.reference);
          pass.draw(3 * draw.triangleCount, 1, 3 * draw.firstTriangle, draw.instance);
        }
        // Slots after mesh draws that are not drawn (the mesh path is unavailable).
        while (mainSlots[nextSlot]?.position === position) drawSlot(mainSlots[nextSlot++]!);
      };
      packet.draws.forEach((draw, index) => {
        drawMeshesAt(index);
        const state = draw.clipState ?? 0;
        if (state !== 0 && clipPipelines === null) return;
        const painted = draw.paint === 'gradient';
        const paintPipeline = !painted
          ? null
          : state === 0
            ? (paintPipelines?.analytic ?? null)
            : (paintPipelines?.analyticClip ?? null);
        if (painted && paintPipeline === null) return;
        const kind = `analytic${painted ? '+paint' : ''}${state !== 0 ? '+clip' : ''}`;
        const pipeline = paintPipeline ?? (state === 0 ? this.#pipeline : clipPipelines!.analytic);
        const switched = bound !== kind;
        if (bound === null || !bound.startsWith('analytic')) {
          bindAnalytic(pipeline);
        } else if (bound !== kind) {
          pass.setPipeline(pipeline);
        }
        if (painted && switched) bindPaint(paintBuffers!.primitiveBindGroup, state !== 0);
        bound = kind;
        if (state !== 0) bindClip(state);
        pass.drawIndexed(6, draw.count, 0, 0, draw.first);
      });
      drawMeshesAt(packet.draws.length);
      pass.end();
      if (capture !== null) {
        // E10 contract, sections 4 and 5: in this encoder, after the main pass, so the copy is
        // of the presented texture in the frame's one submission.
        const target = this.#target;
        capture.encode({
          device: this.#device,
          encoder,
          resources: this.#resources,
          idPrefix: `test/${this.#generation}/capture-${this.#nextCapture++}`,
          packet,
          presentation,
          width: target.width,
          height: target.height,
          sampleCount: this.sampleCount,
          format: this.#format,
          mesh: meshArena === null ? null : { bindGroup: meshArena.bindGroup, draws: meshDraws },
          count: this.#count,
        });
      }
      const commandBuffer = encoder.finish();
      this.#device.queue.submit([commandBuffer]);
      submittedWork = true;

      const serial = this.#nextSubmissionSerial;
      this.#nextSubmissionSerial += 1;
      arena.allocator.markSubmitted(
        this.#generation,
        serial,
        RESOURCE_ORDER.map((id) => arena.allocations[id]),
      );
      arena.lastSubmittedSerial = serial;
      if (meshArena !== null) {
        meshArena.allocator.markSubmitted(this.#generation, serial, meshArena.allocationList);
        meshArena.lastSubmittedSerial = serial;
      }
      this.#latestSubmittedSerial = serial;
      this.#commitPacket(packet, validated);
      if (mesh !== null && !mesh.skipped) this.#commitMesh(mesh);
      this.#releaseTransients(transients);
      this.#commitMasks(clip);
      if (layers !== null) {
        this.#layerPasses += layers.layers.length;
        this.#effectPasses += layers.effects.filter((effect) => effect?.result != null).length;
        this.#blendSplits += layers.splitCount;
      }
      this.#observeCompletion();
      return Object.freeze({
        status: 'submitted',
        receipt: createReceipt(
          packet,
          serial,
          validated.receiptResources,
          mesh === null ? undefined : meshReceipt(packet.mesh!, mesh),
          textReceipt,
        ),
      });
    } catch (error) {
      if (validated.createdArena) this.#releaseArena(arena);
      if (mesh !== null && !mesh.skipped && mesh.createdArena && mesh.arena !== null) {
        this.#releaseArena(mesh.arena);
      }
      if (clip !== null && !submittedWork) this.#discardCreatedMasks(clip.masks);
      this.#releaseTransients(transients);
      // U4: a mask pass's transient attachment that cannot be created is an allocation failure.
      return frozenResult(
        !submittedWork && error instanceof AllocationError
          ? 'allocation-failed'
          : 'submission-failed',
      );
    }
  }

  public dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#packedClipStates.clear();
    this.#capture?.reject(new CaptureError('disposed', 'the scene was disposed'));
    this.#capture = undefined;
    // Section 4: a submitted capture releases its objects before its promise settles.
    this.#inFlight?.fail(new CaptureError('disposed', 'the scene was disposed'));
    this.#inFlight = null;
    let firstError: unknown;
    const release = (action: () => void) => {
      try {
        action();
      } catch (error) {
        firstError ??= error;
      }
    };
    release(() => this.#releaseAttachment());
    if (this.#currentArena !== undefined) release(() => this.#releaseArena(this.#currentArena!));
    this.#currentArena = undefined;
    if (this.#currentMeshArena !== undefined) {
      release(() => this.#releaseArena(this.#currentMeshArena!));
    }
    this.#currentMeshArena = undefined;
    for (const arena of this.#retiredArenas) release(() => this.#releaseArena(arena));
    this.#retiredArenas = [];
    release(() => this.#releaseClipBuffer());
    release(() => this.#releasePaintBuffers());
    release(() => this.#releaseMasks());
    release(() => this.#releaseTextPages());
    release(() => this.#releaseTextBuffer());
    if (this.#clip !== null) release(() => this.#clip!.defaultMask.destroy());
    release(() => this.#pipelineCache.dispose());
    release(() => this.#vertexBuffer.destroy());
    release(() => this.#indexBuffer.destroy());
    for (const id of this.#staticResourceIds) release(() => this.#resources.release(id));
    if (firstError !== undefined) throw asError(firstError, 'Primitive scene disposal failed.');
  }

  /**
   * P4 contract, U3 and U4: checks the clip part against the draws that will be encoded and
   * packs the records. A draw's clip state must name a record of the part; a part without a
   * clipped draw is checked and writes nothing. Each mask level must follow its parent, lie in
   * the target and name a written primitive slot or a checked mesh draw; a content state under a
   * mask level must name a level of the part. E22-K2: each tile of each level's mask pass takes
   * a state index after `maxIndex`, in level and then tile order; a level whose key or size
   * changed gets a new texture. E22-K3: once the part is validated, cached entries the frame does
   * not reuse are released before any mask texture is created.
   */
  #preflightClip(
    packet: PrimitivePacket,
    analyticDraws: readonly Readonly<{ clipState?: number }>[],
    meshDraws: readonly MeshFillDraw[],
    validated: ValidatedPacket,
  ): ValidatedClip {
    const used = new Set<number>();
    for (const draw of [...analyticDraws, ...meshDraws]) {
      const state: unknown = draw.clipState;
      if (state === undefined) continue;
      if (typeof state !== 'number' || !isPositiveSafeInteger(state)) {
        throw new Error('Invalid clip state.');
      }
      used.add(state);
    }
    const part = packet.clip;
    if (part === undefined) {
      if (used.size > 0) throw new Error('A clipped draw without a clip part.');
      // E30-U5 (L3b): a frame without clip states keeps none.
      this.#packedClipStates.clear();
      return null;
    }
    if (
      part.layoutVersion !== 0 ||
      !isArrayValue(part.states) ||
      !isArrayValue(part.masks) ||
      !isPositiveSafeInteger(part.maxIndex) ||
      typeof part.origin !== 'object' ||
      part.origin === null ||
      typeof part.camera !== 'object' ||
      part.camera === null ||
      ![part.origin.x, part.origin.y, part.camera.x, part.camera.y, part.camera.zoom].every(
        (value) => typeof value === 'number' && Number.isFinite(value),
      ) ||
      !(part.camera.zoom > 0)
    ) {
      throw new Error('Invalid clip part.');
    }
    const records = new Map<number, ClipPacketPart['states'][number]>();
    let previous = 0;
    for (const record of part.states) {
      if (!isPositiveSafeInteger(record.index) || record.index <= previous) {
        throw new Error('Clip states must be in increasing index order.');
      }
      previous = record.index;
      records.set(record.index, record);
    }
    if (previous !== part.maxIndex) throw new Error('Clip maxIndex mismatch.');
    for (const state of used) {
      if (!records.has(state)) throw new Error('A draw names a missing clip state.');
    }
    const frame = packClipFrame(part, packet.frame.devicePixelRatio);
    if (frame === null) throw new Error('Clip frame lanes are not finite.');
    const target = packet.frame;
    const levels = new Map<string, ClipMaskPacketLevel>();
    const passStates = new Map<number, Uint8Array>();
    for (const level of part.masks) {
      const device = level.device;
      if (
        typeof level.id !== 'string' ||
        levels.has(level.id) ||
        (level.parent !== null && !levels.has(level.parent)) ||
        typeof level.key !== 'string' ||
        !isArrayValue(level.rects) ||
        ![device.x, device.y].every((value) => Number.isSafeInteger(value) && value >= 0) ||
        !isPositiveSafeInteger(device.width) ||
        !isPositiveSafeInteger(device.height) ||
        device.x + device.width > target.width ||
        device.y + device.height > target.height ||
        !validMaskSource(level.source, validated)
      ) {
        throw new Error('Invalid mask level.');
      }
      levels.set(level.id, level);
    }
    // E22-K1: the tile set covers the largest level; every level's pass runs in its tiles, each
    // with its own pass state after `maxIndex`, in level order.
    const tileSet = maskTileSet(
      Math.max(0, ...part.masks.map((level) => level.device.width)),
      Math.max(0, ...part.masks.map((level) => level.device.height)),
      this.sampleCount,
    );
    const levelTiles = new Map<string, MaskTile[]>();
    let nextPassState = part.maxIndex + 1;
    for (const level of part.masks) {
      const device = level.device;
      const parent = level.parent === null ? null : levels.get(level.parent)!;
      const tiles: MaskTile[] = [];
      for (let y = 0; y < device.height; y += tileSet.height) {
        for (let x = 0; x < device.width; x += tileSet.width) {
          // E22-K2: a tile pixel maps to a target pixel and a parent texel through the tile's
          // offset in the level's rect.
          const bytes = packClipState(
            { rects: level.rects, masks: parent === null ? [] : [parent.id] },
            part.origin,
            {
              maskOffset:
                parent === null
                  ? null
                  : [device.x + x - parent.device.x, device.y + y - parent.device.y],
              pixelShift: [device.x + x, device.y + y],
            },
          );
          if (bytes === null) throw new Error('Unsupported mask pass record.');
          const state = nextPassState++;
          passStates.set(state, bytes);
          tiles.push(
            Object.freeze({
              x,
              y,
              width: Math.min(tileSet.width, device.width - x),
              height: Math.min(tileSet.height, device.height - y),
              state,
            }),
          );
        }
      }
      levelTiles.set(level.id, tiles);
    }
    const states = new Map<number, Uint8Array>();
    const stateMasks = new Map<number, string>();
    const packed = new Map<number, PackedClipState>();
    for (const record of records.values()) {
      if (!record.masks.every((id) => levels.has(id))) {
        throw new Error('A clip state names a missing mask level.');
      }
      const innermost = record.masks.at(-1);
      let bytes: Uint8Array | null;
      let maskX = 0;
      let maskY = 0;
      if (innermost !== undefined) {
        const level = levels.get(innermost);
        if (level === undefined) throw new Error('A clip state names a missing mask level.');
        stateMasks.set(record.index, innermost);
        maskX = -level.device.x;
        maskY = -level.device.y;
      }
      // E30-U5 (L3b): the bytes are a function of the record's contents, the origin and the
      // mask offset, so a deeply frozen record seen last frame under the same lanes keeps them.
      const kept = this.#reusePackedClipStates
        ? this.#packedClipStates.get(record.index)
        : undefined;
      if (
        kept !== undefined &&
        kept.record === record &&
        kept.originX === part.origin.x &&
        kept.originY === part.origin.y &&
        kept.maskX === maskX &&
        kept.maskY === maskY
      ) {
        bytes = kept.bytes;
        this.reusedClipStatesForTesting += 1;
      } else if (innermost === undefined) {
        bytes = packClipState(record, part.origin);
      } else {
        bytes = packClipState(record, part.origin, {
          maskOffset: [maskX, maskY],
          pixelShift: [0, 0],
        });
      }
      if (bytes === null) throw new Error('Unsupported clip state record.');
      states.set(record.index, bytes);
      if (this.#reusePackedClipStates && deeplyFrozenClipRecord(record)) {
        packed.set(
          record.index,
          kept?.bytes === bytes
            ? kept
            : Object.freeze({
                record,
                originX: part.origin.x,
                originY: part.origin.y,
                maskX,
                maskY,
                bytes,
              }),
        );
      }
    }
    if (this.#reusePackedClipStates) this.#packedClipStates = packed;
    if (this.#clip === null || used.size === 0) return null;
    for (const [index, bytes] of passStates) states.set(index, bytes);
    const capacity = nextPassState - 1;
    const stride = this.#clipStride();
    const current = this.#clipBuffer;
    const createdBuffer = current === undefined || current.capacity < capacity;
    const reusable = (level: ClipMaskPacketLevel) => {
      const cached = this.#masks.get(level.id);
      return cached !== undefined &&
        cached.width === level.device.width &&
        cached.height === level.device.height
        ? cached
        : undefined;
    };
    // E22-K3: entries the frame does not reuse are released before any mask texture is created,
    // so the frame never holds a level's old and new textures at once.
    const kept = new Set(part.masks.map(reusable).filter((entry) => entry !== undefined));
    for (const [levelId, entry] of this.#masks) {
      if (kept.has(entry)) continue;
      this.#masks.delete(levelId);
      this.#destroyQuietly(entry);
    }
    const planned: PlannedMask[] = [];
    try {
      for (const level of part.masks) {
        const cached = reusable(level);
        const entry = cached ?? this.#createMaskEntry(level);
        planned.push(
          Object.freeze({
            level,
            entry,
            created: cached === undefined,
            render: cached === undefined || cached.key !== level.key,
            tiles: levelTiles.get(level.id)!,
          }),
        );
      }
      const buffer = createdBuffer
        ? this.#createClipBuffer(nextPowerOfTwo(capacity), stride)
        : current;
      return Object.freeze({
        buffer,
        createdBuffer,
        stride,
        frame: new Uint8Array(frame.buffer),
        states,
        masks: Object.freeze(planned),
        maskById: new Map(planned.map((mask) => [mask.level.id, mask])),
        stateMasks,
        tileSet: Object.freeze({ width: tileSet.width, height: tileSet.height }),
      });
    } catch (error) {
      this.#discardCreatedMasks(planned);
      throw error;
    }
  }

  /** U4: creates and tracks a mask level's texture; its key is set once it is rendered. */
  #createMaskEntry(level: ClipMaskPacketLevel): MaskEntry {
    const id = `primitive/${this.#generation}/mask-${this.#nextMask++}`;
    const { width, height } = level.device;
    const texture = this.#createTrackedTexture(
      id,
      width,
      height,
      CLIP_MASK_FORMAT,
      1,
      1,
      TEXTURE_BINDING_USAGE | TEXTURE_COPY_DESTINATION_USAGE,
    );
    return {
      id,
      levelId: level.id,
      texture,
      width,
      height,
      key: '',
      bindGroup: null,
      bindGroupBuffer: null,
    };
  }

  /**
   * Creates a 2D texture and its accounting entry; an `AllocationError` leaves neither. Any
   * texture is a render attachment; `usage` adds binding and copy usages.
   */
  #createTrackedTexture(
    id: string,
    width: number,
    height: number,
    format: GPUTextureFormat,
    sampleCount: number,
    bytesPerTexel: number,
    usage = 0,
  ): GPUTexture {
    return this.#createTrackedTextureWithUsage(
      id,
      width,
      height,
      format,
      sampleCount,
      bytesPerTexel,
      RENDER_ATTACHMENT_USAGE | usage,
    );
  }

  /**
   * E28 U3: as `#createTrackedTexture`, with exactly the given usage; atlas pages are sampled
   * and written by the queue, never rendered to.
   */
  #createTrackedTextureWithUsage(
    id: string,
    width: number,
    height: number,
    format: GPUTextureFormat,
    sampleCount: number,
    bytesPerTexel: number,
    usage: number,
  ): GPUTexture {
    const maximum = safeLimit(this.#device.limits.maxTextureDimension2D, 0);
    if (width > maximum || height > maximum) {
      throw new AllocationError();
    }
    let texture: GPUTexture;
    try {
      texture = this.#device.createTexture({
        label: id,
        size: { width, height },
        sampleCount,
        format,
        usage,
      });
    } catch (error) {
      throw new AllocationError(error);
    }
    try {
      this.#resources.track(id, {
        category: 'texture',
        dimension: '2d',
        width,
        height,
        depthOrArrayLayers: 1,
        mipLevelCount: 1,
        sampleCount,
        bytesPerTexel,
      });
    } catch (error) {
      texture.destroy();
      throw new AllocationError(error);
    }
    return texture;
  }

  /** Destroys a tracked texture and releases its accounting entry. */
  #destroyTrackedTexture(id: string, texture: GPUTexture): void {
    try {
      texture.destroy();
    } finally {
      this.#resources.release(id);
    }
  }

  /** U4: releases the entries a failed packet created; cached entries keep their content. */
  #discardCreatedMasks(planned: readonly PlannedMask[]): void {
    for (const mask of planned) {
      if (mask.created) this.#destroyTrackedTexture(mask.entry.id, mask.entry.texture);
    }
  }

  /**
   * U4 (Mask cache): after a submission, the rendered entries take their level's key, created
   * entries replace the cached ones, and every entry the frame did not use is released.
   */
  #commitMasks(clip: ValidatedClip): void {
    const used = new Set<string>();
    for (const mask of clip?.masks ?? []) {
      if (mask.render) this.#maskPasses += 1;
      mask.entry.key = mask.level.key;
      used.add(mask.entry.id);
      const previous = this.#masks.get(mask.level.id);
      this.#masks.set(mask.level.id, mask.entry);
      if (previous !== undefined && previous !== mask.entry) this.#destroyQuietly(previous);
    }
    for (const [levelId, entry] of this.#masks) {
      if (used.has(entry.id)) continue;
      this.#masks.delete(levelId);
      this.#destroyQuietly(entry);
    }
  }

  /** Releases a mask texture after a submission; a release error must not undo the frame. */
  #destroyQuietly(entry: MaskEntry): void {
    try {
      this.#destroyTrackedTexture(entry.id, entry.texture);
    } catch {
      // Accounting cleanup is best effort.
    }
  }

  /** U4: releases every mask texture (resize, dispose). */
  #releaseMasks(): void {
    const entries = [...this.#masks.values()];
    this.#masks.clear();
    let firstError: unknown;
    for (const entry of entries) {
      try {
        this.#destroyTrackedTexture(entry.id, entry.texture);
      } catch (error) {
        firstError ??= error;
      }
    }
    if (firstError !== undefined) throw asError(firstError, 'Mask release failed.');
  }

  /** E22-A8: the pipeline cache's entry counts. */
  public pipelineCacheSnapshotForTesting(): PipelineCacheSnapshot {
    return this.#pipelineCache.snapshot();
  }

  /** U4 (P4-A08): mask passes run so far; a pass runs only for a level whose key changed. */
  /** E25 section 4, Lifetime: the layer passes submitted, one per layer, not per tile. */
  public get layerPasses(): number {
    return this.#layerPasses;
  }

  /** E41 U5: effect roots submitted with their effects this generation, one per root and frame. */
  /** V35-K8: backdrop splits so far, one per end-and-resume of a pass around a snapshot. */
  public get blendSplits(): number {
    return this.#blendSplits;
  }

  public get effectPasses(): number {
    return this.#effectPasses;
  }

  /** E41 section 5.4: the device limit that bounds effect textures. */
  public get maxTextureDimension2D(): number {
    return safeLimit(this.#device.limits.maxTextureDimension2D, 0);
  }

  public get maskPasses(): number {
    return this.#maskPasses;
  }

  /** The bind group of a state: its innermost mask level's, or the buffer's default. */
  #clipBindGroup(clip: NonNullable<ValidatedClip>, state: number): GPUBindGroup {
    const levelId = clip.stateMasks.get(state);
    if (levelId === undefined) return clip.buffer.bindGroup;
    return clip.maskById.get(levelId)!.entry.bindGroup!;
  }

  /**
   * U4 and E22-K2: encodes the mask passes of each level whose texture is rendered this frame,
   * parents first, before the main pass. Every pass renders one tile of the level into the
   * frame's tile set (E22-K1); the viewport keeps the target's pixel grid, offset by the rect's
   * origin and the tile's offset, and the 1-sample tile (the resolve tile at 4x) is copied into
   * the level's texture at the tile's offset. A primitive source is drawn by its slot; a mesh
   * source with its draw, under the E17-K2 write-once stencil at reference 1.
   */
  #encodeMaskPasses(
    encoder: GPUCommandEncoder,
    clip: NonNullable<ValidatedClip>,
    arena: ArenaState,
    meshArena: MeshArenaState | null,
    transients: Transient[],
  ): void {
    const pipelines = this.#clip!;
    const target = this.#target!;
    const meshDrawOf = (mask: PlannedMask) =>
      mask.level.source.kind === 'mesh' && meshArena !== null && pipelines.maskMesh !== null
        ? mask.level.source.draw
        : null;
    const rendered = clip.masks.filter((mask) => mask.render);
    if (rendered.length === 0) return;
    const prefix = `primitive/${this.#generation}/mask-tiles-${this.#nextTileSet++}`;
    const { width, height } = clip.tileSet;
    const tile = (name: string, format: GPUTextureFormat, sampleCount: number, usage: number) => {
      const id = `${prefix}/${name}`;
      const texture = this.#createTrackedTexture(id, width, height, format, sampleCount, 1, usage);
      transients.push({ id, resource: texture });
      return texture;
    };
    const color = tile(
      'color',
      CLIP_MASK_FORMAT,
      this.sampleCount,
      this.sampleCount === 4 ? 0 : TEXTURE_COPY_SOURCE_USAGE,
    );
    const resolve =
      this.sampleCount === 4
        ? tile('resolve', CLIP_MASK_FORMAT, 1, TEXTURE_COPY_SOURCE_USAGE)
        : null;
    const stencil = rendered.some((mask) => meshDrawOf(mask) !== null)
      ? tile('stencil', MESH_STENCIL_FORMAT, this.sampleCount, 0)
      : null;
    const colorView = color.createView();
    const resolveView = resolve?.createView();
    const stencilView = stencil?.createView();
    const copySource = resolve ?? color;
    for (const mask of rendered) {
      const { level, entry } = mask;
      const source = level.source;
      const meshDraw = meshDrawOf(mask);
      const parentGroup =
        level.parent === null
          ? clip.buffer.bindGroup
          : clip.maskById.get(level.parent)!.entry.bindGroup!;
      for (const part of mask.tiles) {
        // A mesh source without the mesh path, or whose draw did not reach the packet, covers
        // nothing: the pass clears the tile and draws no source.
        const pass = encoder.beginRenderPass({
          label: `vector-studio/mask-pass/${level.id}`,
          colorAttachments: [
            {
              view: colorView,
              ...(resolveView === undefined ? {} : { resolveTarget: resolveView }),
              clearValue: { r: 0, g: 0, b: 0, a: 0 },
              loadOp: 'clear',
              storeOp: resolveView === undefined ? 'store' : 'discard',
            },
          ],
          ...(meshDraw === null || stencilView === undefined
            ? {}
            : {
                depthStencilAttachment: {
                  view: stencilView,
                  stencilClearValue: 0,
                  stencilLoadOp: 'clear',
                  stencilStoreOp: 'discard',
                },
              }),
        });
        pass.setViewport(
          -(level.device.x + part.x),
          -(level.device.y + part.y),
          target.width,
          target.height,
          0,
          1,
        );
        if (source.kind === 'primitive') {
          pass.setPipeline(pipelines.maskAnalytic);
          pass.setBindGroup(0, arena.bindGroup);
          pass.setBindGroup(CLIP_BIND_GROUP_INDEX, parentGroup, [part.state * clip.stride]);
          pass.setVertexBuffer(0, this.#vertexBuffer, 0, 32);
          pass.setIndexBuffer(this.#indexBuffer, 'uint16', 0, 12);
          pass.drawIndexed(6, 1, 0, 0, source.slot);
        } else if (meshDraw !== null && meshDraw.coverage !== undefined) {
          // E39-R7: a winding source's stencil pass, then its mask cover. The tile pass's
          // stencil starts cleared, so no reset draw is needed.
          const stencilTriangles = meshDraw.triangleCount - 2;
          pass.setPipeline(pipelines.maskStencil!);
          pass.setBindGroup(0, meshArena!.bindGroup);
          pass.setBindGroup(CLIP_BIND_GROUP_INDEX, parentGroup, [part.state * clip.stride]);
          pass.setStencilReference(0);
          pass.draw(3 * stencilTriangles, 1, 3 * meshDraw.firstTriangle, meshDraw.instance);
          pass.setPipeline(pipelines.maskCover![meshCoverRule(meshDraw)]);
          pass.draw(6, 1, 3 * (meshDraw.firstTriangle + stencilTriangles), meshDraw.instance);
        } else if (meshDraw !== null) {
          pass.setPipeline(pipelines.maskMesh!);
          pass.setBindGroup(0, meshArena!.bindGroup);
          pass.setBindGroup(CLIP_BIND_GROUP_INDEX, parentGroup, [part.state * clip.stride]);
          pass.setStencilReference(1);
          pass.draw(3 * meshDraw.triangleCount, 1, 3 * meshDraw.firstTriangle, meshDraw.instance);
        }
        pass.end();
        encoder.copyTextureToTexture(
          { texture: copySource },
          { texture: entry.texture, origin: { x: part.x, y: part.y } },
          { width: part.width, height: part.height },
        );
      }
    }
  }

  /**
   * E25 section 4: checks the layers part against the packet and plans the layer tiles and the
   * pass and composite records. Each layer is post-ordered, even-origined and inside its parent;
   * each has one composite on its parent's pass, in that target's paint order.
   */
  /**
   * E28 section 4: checks the text part: its page plan (at most 8 pages of one size, no larger
   * than 2048 or the adapter's 2D texture limit), clears and uploads inside their pages, the
   * instance records, and each draw's records and page. `orderSlots` has checked the draws'
   * targets and order keys, `#preflightClip` their clip states. Throws on a violation
   * (`invalid-packet`), or with `AllocationError` when the records exceed the buffer limits.
   */
  #preflightText(packet: PrimitivePacket): ValidatedText {
    const part = packet.text;
    if (part === undefined) return null;
    const maximum = Math.min(
      E28_ATLAS_PAGE_SIZE,
      safeLimit(this.#device.limits.maxTextureDimension2D, E28_ATLAS_PAGE_SIZE),
    );
    if (
      typeof part !== 'object' ||
      part === null ||
      part.layoutVersion !== 0 ||
      !isPositiveSafeInteger(part.pageSize) ||
      part.pageSize > maximum ||
      !Number.isSafeInteger(part.pageCount) ||
      part.pageCount < 0 ||
      part.pageCount > E28_ATLAS_PAGES_MAX ||
      !isArrayValue(part.clears) ||
      !isArrayValue(part.uploads) ||
      !isArrayValue(part.draws) ||
      !isArrayValue(part.notices) ||
      !(part.instances instanceof Float32Array) ||
      part.instances.length % (TEXT_INSTANCE_SIZE / 4) !== 0
    ) {
      throw new Error('Invalid text part.');
    }
    const inPage = (area: TextPacketPart['clears'][number]) =>
      typeof area === 'object' &&
      area !== null &&
      Number.isSafeInteger(area.page) &&
      area.page >= 0 &&
      area.page < part.pageCount &&
      [area.x, area.y].every((value) => Number.isSafeInteger(value) && value >= 0) &&
      isPositiveSafeInteger(area.width) &&
      isPositiveSafeInteger(area.height) &&
      area.x + area.width <= part.pageSize &&
      area.y + area.height <= part.pageSize;
    if (!part.clears.every(inPage)) throw new Error('Invalid text clear.');
    for (const upload of part.uploads) {
      if (
        !inPage(upload) ||
        !(upload.coverage instanceof Uint8Array) ||
        upload.coverage.byteLength !== upload.width * upload.height
      ) {
        throw new Error('Invalid text upload.');
      }
    }
    const records = part.instances.length / (TEXT_INSTANCE_SIZE / 4);
    for (const draw of part.draws) {
      if (
        !Number.isSafeInteger(draw.first) ||
        draw.first < 0 ||
        !isPositiveSafeInteger(draw.count) ||
        draw.first + draw.count > records ||
        !Number.isSafeInteger(draw.page) ||
        draw.page < 0 ||
        draw.page >= part.pageCount
      ) {
        throw new Error('Invalid text draw.');
      }
    }
    const instanceBytes = part.instances.byteLength;
    const limits = this.#device.limits;
    const fits =
      instanceBytes <= safeLimit(limits.maxStorageBufferBindingSize, 0) &&
      this.#textInstanceOffset() + instanceBytes <= safeLimit(limits.maxBufferSize, 0);
    return Object.freeze({ part, instanceBytes, fits });
  }

  /** E28 U3: the instance records' offset in the text buffer, after the target uniform. */
  #textInstanceOffset(): number {
    const alignment = Math.max(
      safeLimit(this.#device.limits.minStorageBufferOffsetAlignment, 256),
      TEXT_TARGET_SIZE,
    );
    return align(TEXT_TARGET_SIZE, alignment);
  }

  /**
   * E28 section 4, Lifetime: creates or releases pages to match `pageCount` (all pages again
   * when the page size changed), zeroes the clears and writes the uploads, then the text
   * buffer. Without the text pipeline, or once a page could not be created this generation
   * (E28-D1, `'page-allocation'`), nothing is written: pages are released and the receipt
   * names stable placeholder incarnations, so the plan settles while text stays undrawn.
   */
  #applyText(text: NonNullable<ValidatedText>): TextReceiptPart {
    const { part } = text;
    const receipt = (pages: readonly symbol[]) =>
      Object.freeze({
        pages: Object.freeze([...pages]),
        clears: part.clears.length,
        uploads: part.uploads.length,
      });
    const unavailable = () => {
      this.#releaseTextPages();
      this.#releaseTextBuffer();
      while (this.#textPlaceholders.length < part.pageCount) {
        this.#textPlaceholders.push(Symbol('text-page-unavailable'));
      }
      return receipt(this.#textPlaceholders.slice(0, part.pageCount));
    };
    if (this.#text === null || this.#textPageAllocationFailed) return unavailable();
    if (!text.fits) {
      this.#textPageAllocationFailed = true;
      return unavailable();
    }
    if (this.#textPages.some((page) => page.size !== part.pageSize)) this.#releaseTextPages();
    while (this.#textPages.length > part.pageCount) this.#releaseTextPage(this.#textPages.pop()!);
    while (this.#textPages.length < part.pageCount) {
      const page = this.#createTextPage(part.pageSize);
      if (page === null) {
        this.#textPageAllocationFailed = true;
        return unavailable();
      }
      this.#textPages.push(page);
    }
    const queue = this.#device.queue;
    for (const clear of part.clears) {
      // In bands of whole rows from one small zero buffer, so a page clear holds no 4 MiB array.
      const rows = Math.max(1, Math.floor(TEXT_ZEROS_SIZE / clear.width));
      for (let y = 0; y < clear.height; y += rows) {
        const height = Math.min(rows, clear.height - y);
        queue.writeTexture(
          {
            texture: this.#textPages[clear.page]!.texture,
            origin: { x: clear.x, y: clear.y + y },
          },
          TEXT_ZEROS,
          { offset: 0, bytesPerRow: clear.width, rowsPerImage: height },
          { width: clear.width, height },
        );
      }
    }
    for (const upload of part.uploads) {
      queue.writeTexture(
        { texture: this.#textPages[upload.page]!.texture, origin: { x: upload.x, y: upload.y } },
        upload.coverage,
        { offset: 0, bytesPerRow: upload.width, rowsPerImage: upload.height },
        { width: upload.width, height: upload.height },
      );
    }
    if (!this.#writeTextBuffer(text)) {
      this.#textPageAllocationFailed = true;
      return unavailable();
    }
    return receipt(this.#textPages.map((page) => page.incarnation));
  }

  /** E28 U3: a page texture, tracked; null when it cannot be created or tracked. */
  #createTextPage(size: number): TextPage | null {
    const id = `primitive/${this.#generation}/text-page-${this.#nextTextPage++}`;
    let texture: GPUTexture;
    try {
      texture = this.#createTrackedTextureWithUsage(
        id,
        size,
        size,
        TEXT_PAGE_FORMAT,
        1,
        1,
        TEXTURE_BINDING_USAGE | TEXTURE_COPY_DESTINATION_USAGE,
      );
    } catch {
      return null;
    }
    try {
      return Object.freeze({
        id,
        texture,
        view: texture.createView(),
        size,
        incarnation: Symbol(id),
      });
    } catch {
      try {
        this.#destroyTrackedTexture(id, texture);
      } catch {
        // Accounting cleanup is best effort.
      }
      return null;
    }
  }

  #releaseTextPage(page: TextPage): void {
    this.#textBuffer?.bindGroups.delete(page);
    this.#destroyTrackedTexture(page.id, page.texture);
  }

  /** E28 section 4, Release: on a frame without text, a page allocation failure and dispose. */
  #releaseTextPages(): void {
    const pages = this.#textPages;
    this.#textPages = [];
    let firstError: unknown;
    for (const page of pages) {
      try {
        this.#releaseTextPage(page);
      } catch (error) {
        firstError ??= error;
      }
    }
    if (firstError !== undefined) throw asError(firstError, 'Text page release failed.');
  }

  /**
   * E28 U3: writes the target uniform when it changed and the instance records, growing the
   * buffer to a power of two; a frame without text draws releases it. False when the buffer
   * cannot be created or tracked.
   */
  #writeTextBuffer(text: NonNullable<ValidatedText>): boolean {
    if (text.part.draws.length === 0) {
      this.#releaseTextBuffer();
      return true;
    }
    const instanceOffset = this.#textInstanceOffset();
    const size = instanceOffset + text.instanceBytes;
    let state = this.#textBuffer;
    if (state === undefined || state.size < size) {
      this.#releaseTextBuffer();
      const capacity = Math.min(
        nextPowerOfTwo(size),
        Math.max(size, safeLimit(this.#device.limits.maxBufferSize, 0)),
      );
      const id = `primitive/${this.#generation}/text-buffer-${this.#nextTextBuffer++}`;
      let buffer: GPUBuffer;
      try {
        buffer = this.#device.createBuffer({
          label: id,
          size: capacity,
          usage: STORAGE_BUFFER_USAGE | UNIFORM_BUFFER_USAGE | COPY_DESTINATION_USAGE,
        });
      } catch {
        return false;
      }
      try {
        this.#resources.track(id, { category: 'buffer', size: capacity });
      } catch {
        buffer.destroy();
        return false;
      }
      state = { id, buffer, size: capacity, instanceOffset, bindGroups: new Map(), target: null };
      this.#textBuffer = state;
    }
    const target = this.#target!;
    const targetBytes = packTextTarget(target.width, target.height);
    if (state.target === null || !bytesEqual(state.target, targetBytes)) {
      this.#device.queue.writeBuffer(state.buffer, 0, targetBytes, 0, targetBytes.byteLength);
      state.target = targetBytes;
    }
    const instances = text.part.instances;
    this.#device.queue.writeBuffer(
      state.buffer,
      state.instanceOffset,
      instances,
      0,
      instances.length,
    );
    return true;
  }

  #releaseTextBuffer(): void {
    const state = this.#textBuffer;
    if (state === undefined) return;
    this.#textBuffer = undefined;
    let releaseError: unknown;
    try {
      state.buffer.destroy();
    } catch (error) {
      releaseError = error;
    }
    this.#resources.release(state.id);
    if (releaseError !== undefined) throw asError(releaseError, 'Text buffer release failed.');
  }

  /** E28 U3: group 0 for a page: the instance records, the page, the sampler, the target. */
  #textBindGroup(index: number): GPUBindGroup {
    const state = this.#textBuffer!;
    const page = this.#textPages[index]!;
    const cached = state.bindGroups.get(page);
    if (cached !== undefined) return cached;
    const group = this.#device.createBindGroup({
      label: `${state.id}/${page.id.slice(page.id.lastIndexOf('/') + 1)}`,
      layout: this.#text!.bindGroupLayout,
      entries: [
        {
          binding: TEXT_BINDINGS.instances,
          resource: {
            buffer: state.buffer,
            offset: state.instanceOffset,
            // The records fit the binding limit (#preflightText); the grown buffer may not.
            size: Math.min(
              state.size - state.instanceOffset,
              Math.floor(safeLimit(this.#device.limits.maxStorageBufferBindingSize, 0) / 4) * 4,
            ),
          },
        },
        { binding: TEXT_BINDINGS.page, resource: page.view },
        { binding: TEXT_BINDINGS.sampler, resource: this.#text!.sampler },
        {
          binding: TEXT_BINDINGS.target,
          resource: { buffer: state.buffer, offset: 0, size: TEXT_TARGET_SIZE },
        },
      ],
    });
    state.bindGroups.set(page, group);
    return group;
  }

  /** E28-D1: true once a page or the text buffer could not be created this generation. */
  get textPageAllocationFailed(): boolean {
    return this.#textPageAllocationFailed;
  }

  #preflightLayers(
    packet: PrimitivePacket,
    layers: LayerPacketPart['layers'],
    meshDraws: readonly (readonly MeshFillDraw[])[],
    slots: ReadonlyMap<number, readonly OrderSlot[]>,
  ): ValidatedLayers {
    const part = packet.layers;
    if (part === undefined || layers.length === 0) {
      if (part !== undefined && part.composites.length !== 0) {
        throw new Error('Composites without layers.');
      }
      return null;
    }
    const target = this.#target!;
    const count = layers.length;
    // E41 U5b: an effect root and every layer inside one draw through the shifted variants when
    // the effect pipeline exists, so their bounds may reach past the target (E41-K2), up to the
    // device's texture limit; other layers stay inside the target (E25-K5).
    const maximum = safeLimit(this.#device.limits.maxTextureDimension2D, 0);
    const shifted: boolean[] = new Array<boolean>(count).fill(false);
    for (let index = count - 1; index >= 0; index -= 1) {
      const layer = layers[index]!;
      const parent = layer.parent;
      shifted[index] =
        this.#effect !== null &&
        (layer.effect !== undefined ||
          (Number.isSafeInteger(parent) && parent > index && parent < count && shifted[parent]!));
    }
    layers.forEach((layer, index) => {
      const bound = layer.bound;
      const free = shifted[index]!;
      if (
        typeof layer.nodeId !== 'string' ||
        typeof layer.opacity !== 'number' ||
        !(layer.opacity > 0 && layer.opacity <= 1) ||
        typeof bound !== 'object' ||
        bound === null ||
        ![bound.x, bound.y].every(
          (value) => Number.isSafeInteger(value) && (free || value >= 0) && value % 2 === 0,
        ) ||
        !isPositiveSafeInteger(bound.width) ||
        !isPositiveSafeInteger(bound.height) ||
        (free
          ? bound.width > maximum ||
            bound.height > maximum ||
            bound.x < -E41_LAYER_REACH_MAX ||
            bound.y < -E41_LAYER_REACH_MAX ||
            bound.x + bound.width > target.width + E41_LAYER_REACH_MAX ||
            bound.y + bound.height > target.height + E41_LAYER_REACH_MAX
          : bound.x + bound.width > target.width || bound.y + bound.height > target.height) ||
        !Number.isSafeInteger(layer.parent) ||
        !(layer.parent === -1 || (layer.parent > index && layer.parent < count))
      ) {
        throw new Error('Invalid layer.');
      }
      if (layer.parent !== -1) {
        const parent = layers[layer.parent]!.bound;
        if (
          bound.x < parent.x ||
          bound.y < parent.y ||
          bound.x + bound.width > parent.x + parent.width ||
          bound.y + bound.height > parent.y + parent.height
        ) {
          throw new Error('A layer outside its parent.');
        }
      }
    });
    const seen = new Set<number>();
    const compositeStates = new Array<number>(count).fill(0);
    for (const composite of part.composites) {
      if (
        typeof composite !== 'object' ||
        composite === null ||
        !Number.isSafeInteger(composite.layer) ||
        composite.layer < 0 ||
        composite.layer >= count ||
        seen.has(composite.layer) ||
        composite.target !== layers[composite.layer]!.parent ||
        !Number.isSafeInteger(composite.position) ||
        composite.position < 0 ||
        // E41-K2b: only an effect root's composite carries a clip state (checked as a draw's).
        (composite.clipState !== undefined && layers[composite.layer]!.effect === undefined)
      ) {
        throw new Error('Invalid composite.');
      }
      seen.add(composite.layer);
      compositeStates[composite.layer] = composite.clipState ?? 0;
    }
    if (seen.size !== count) throw new Error('A layer without its composite.');
    // Without the layer pipeline the layers' content is not drawn (fail closed), as E23's
    // gradient draws are without the paint variants; the part is still checked.
    if (this.#layer === null) return null;
    // Section 4: the tile set covers the largest layer, at most T on each side.
    const tileWidth = Math.min(
      this.#layerTileSize,
      layers.reduce((widest, layer) => Math.max(widest, layer.bound.width), 0),
    );
    const tileHeight = Math.min(
      this.#layerTileSize,
      layers.reduce((tallest, layer) => Math.max(tallest, layer.bound.height), 0),
    );
    const alignment = this.#device.limits.minUniformBufferOffsetAlignment;
    if (typeof alignment !== 'number' || !isPowerOfTwo(alignment)) throw new AllocationError();
    const stride = align(
      Math.max(
        LAYER_PASS_RECORD_SIZE,
        LAYER_COMPOSITE_RECORD_SIZE,
        EFFECT_PASS_RECORD_SIZE,
        BACKDROP_SNAPSHOT_RECORD_SIZE,
      ),
      alignment,
    );
    const passRecords: Uint8Array[] = [
      packLayerPassRecord({ x: 0, y: 0 }, { width: target.width, height: target.height }),
    ];
    const tiles = layers.map((layer, index) => {
      const list: LayerTile[] = [];
      for (let y = 0; y < layer.bound.height; y += tileHeight) {
        for (let x = 0; x < layer.bound.width; x += tileWidth) {
          list.push(
            Object.freeze({
              x,
              y,
              width: Math.min(tileWidth, layer.bound.width - x),
              height: Math.min(tileHeight, layer.bound.height - y),
              record: passRecords.length,
            }),
          );
          passRecords.push(
            // E41 U5b: a shifted pass maps the tile itself; E25's maps the target.
            packLayerPassRecord(
              { x: layer.bound.x + x, y: layer.bound.y + y },
              shifted[index]
                ? { width: tileWidth, height: tileHeight }
                : { width: target.width, height: target.height },
            ),
          );
        }
      }
      return Object.freeze(list);
    });
    const compositeRecordBase = passRecords.length;
    // E41 U5: each effect root's passes, recorded after the composite records.
    let effectRecords = compositeRecordBase + count;
    const effects = layers.map(
      (layer): { -readonly [K in keyof LayerEffectFrame]: LayerEffectFrame[K] } | null => {
        if (layer.effect === undefined) return null;
        validateEffectRecord(layer.effect);
        if (this.#effect === null || this.#effectContentForTesting) return null;
        // `R` inside its parent's bound (which reaches past the target when it is shifted), or
        // inside the target for a root composited in the main pass.
        const result = intersectRects(
          layer.effect.output,
          layer.parent === -1
            ? { x: 0, y: 0, width: target.width, height: target.height }
            : layers[layer.parent]!.bound,
        );
        if (result === null) {
          return {
            result: null,
            plan: Object.freeze({ passes: [], scratch: { width: 0, height: 0 } }),
            recordBase: effectRecords,
            scratchSlot: -1,
          };
        }
        const plan = planEffectPasses(layer.bound, result, layer.effect);
        // Section 5.4: an effect texture past the device limit draws the root without effects.
        // This drop is silent (no notice): the packet's own budget already admitted the root.
        if (plan.scratch.width > maximum || plan.scratch.height > maximum) return null;
        const recordBase = effectRecords;
        effectRecords += plan.passes.length;
        return { result, plan, recordBase, scratchSlot: -1 };
      },
    );
    // Scratch pairs: largest roots first, each root takes the first pair that fits it, or that
    // fits it when grown to both extents within twice the larger area; otherwise a new pair. So
    // similar roots share one pair, and a wide and a tall root never make one of both extents.
    const scratch: { width: number; height: number }[] = [];
    const byArea = effects
      .filter((effect) => effect !== null && effect.plan.scratch.width > 0)
      .sort(
        (a, b) =>
          b!.plan.scratch.width * b!.plan.scratch.height -
          a!.plan.scratch.width * a!.plan.scratch.height,
      );
    for (const effect of byArea) {
      const { width, height } = effect!.plan.scratch;
      let slot = scratch.findIndex((pair) => width <= pair.width && height <= pair.height);
      if (slot === -1) {
        slot = scratch.findIndex((pair) => {
          const grown = Math.max(pair.width, width) * Math.max(pair.height, height);
          return grown <= 2 * Math.max(pair.width * pair.height, width * height);
        });
        if (slot === -1) {
          slot = scratch.length;
          scratch.push({ width, height });
        } else {
          scratch[slot]!.width = Math.max(scratch[slot]!.width, width);
          scratch[slot]!.height = Math.max(scratch[slot]!.height, height);
        }
      }
      effect!.scratchSlot = slot;
    }
    for (const effect of effects) if (effect !== null) Object.freeze(effect);
    // V35-K4, K5: a blend root composites with its mode over its backdrop snapshot when the
    // blend pipeline has the variant its pass and clip state need; otherwise (K7) it composites
    // with source-over, as the packet's plan does when the backend sets no `blendLayers`.
    const targetRect: DeviceRect = { x: 0, y: 0, width: target.width, height: target.height };
    const blends = layers.map((layer, index): LayerBlendFrame | null => {
      if (layer.blend === undefined && layer.backdrop === undefined) return null;
      const margin = layer.backdrop?.margin;
      if (
        typeof layer.blend !== 'string' ||
        !Object.hasOwn(BLEND_MODE_INDEX, layer.blend) ||
        typeof margin !== 'number' ||
        !Number.isSafeInteger(margin) ||
        margin < 0
      ) {
        throw new Error('Invalid blend.');
      }
      const blend = this.#blend;
      if (blend === null) return null;
      const parentShifted = layer.parent !== -1 && shifted[layer.parent]!;
      const clipped = compositeStates[index] !== 0;
      const pipeline = parentShifted
        ? clipped
          ? blend.clipShifted
          : blend.shifted
        : clipped
          ? blend.clip
          : blend.plain;
      if (pipeline === null) return null;
      const effect = effects[index];
      if (effect !== null && effect !== undefined && effect.result === null) return null;
      const composite = effect?.result ?? layer.bound;
      const region = layer.parent === -1 ? targetRect : layers[layer.parent]!.bound;
      const snapshot = backdropRect(composite, margin, region);
      return snapshot === null ? null : Object.freeze({ snapshot, margin });
    });
    const splitPlan = planBackdropSplits(
      layers.map((layer, index) => ({
        parent: layer.parent,
        bound: layer.bound,
        ...(effects[index]?.result == null ? {} : { composite: effects[index].result }),
        ...(blends[index] === null ? {} : { backdrop: { margin: blends[index]!.margin } }),
      })),
      targetRect,
      tileWidth,
      tileHeight,
    );
    const splits = new Map<string, Map<number, BlendSplitFrame>>();
    const splitRecords: Uint8Array[] = [];
    for (const split of splitPlan) {
      const layer = layers[split.layer]!;
      const tile = split.tile === -1 ? null : tiles[layer.parent]![split.tile]!;
      const region =
        tile === null
          ? targetRect
          : {
              x: layers[layer.parent]!.bound.x + tile.x,
              y: layers[layer.parent]!.bound.y + tile.y,
              width: tile.width,
              height: tile.height,
            };
      const key = splitKey(tile === null ? -1 : layer.parent, split.tile);
      let entry = splits.get(key);
      if (entry === undefined) {
        entry = new Map();
        splits.set(key, entry);
      }
      entry.set(
        split.layer,
        Object.freeze({ rect: split.rect, record: effectRecords + splitRecords.length }),
      );
      splitRecords.push(packBackdropSnapshotRecord(blends[split.layer]!.snapshot, region));
    }
    const records = new Uint8Array((effectRecords + splitRecords.length) * stride);
    passRecords.forEach((bytes, index) => records.set(bytes, index * stride));
    splitRecords.forEach((bytes, index) => records.set(bytes, (effectRecords + index) * stride));
    layers.forEach((layer, index) => {
      const effect = effects[index];
      const blend = blends[index];
      const bound = effect?.result ?? layer.bound;
      const alpha =
        effect === null || effect === undefined
          ? layer.opacity
          : layer.opacity * layer.effect!.contentOpacity;
      records.set(
        blend === null || blend === undefined
          ? packLayerCompositeRecord(bound, alpha)
          : packBlendCompositeRecord(bound, alpha, layer.blend!, blend.snapshot),
        (compositeRecordBase + index) * stride,
      );
      effect?.plan.passes.forEach((pass, offset) => {
        records.set(packEffectPassRecord(pass), (effect.recordBase + offset) * stride);
      });
    });
    if (records.byteLength > safeLimit(this.#device.limits.maxBufferSize, 0)) {
      throw new AllocationError();
    }
    return Object.freeze({
      layers,
      slots,
      meshDraws,
      shifted: Object.freeze(shifted),
      compositeStates: Object.freeze(compositeStates),
      tileWidth,
      tileHeight,
      tiles: Object.freeze(tiles),
      records,
      stride,
      compositeRecordBase,
      effects: Object.freeze(effects),
      scratch: Object.freeze(scratch.map((pair) => Object.freeze({ ...pair }))),
      blends: Object.freeze(blends),
      splits,
      splitCount: splitPlan.length,
    });
  }

  /**
   * E25 section 4, Layer passes: creates the frame's records buffer, layer textures and tile set
   * (all transient), then renders each layer, in post-order, tile by tile: the viewport is the
   * target's at −(B_g origin + tile offset), the tile's stencil is cleared, and the 1-sample tile
   * is copied into the layer texture at the tile's offset.
   */
  #encodeLayerPasses(
    encoder: GPUCommandEncoder,
    layers: NonNullable<ValidatedLayers>,
    arena: ArenaState,
    meshArena: MeshArenaState | null,
    clip: ValidatedClip,
    paint: ValidatedPaint,
    transients: Transient[],
    text: Readonly<{ part: TextPacketPart | null }>,
  ): LayerFrame {
    const pipelines = this.#layer!;
    const target = this.#target!;
    const prefix = `primitive/${this.#generation}/layer-frame-${this.#nextLayerFrame++}`;
    const recordsId = `${prefix}/records`;
    let records: GPUBuffer;
    try {
      records = this.#device.createBuffer({
        label: recordsId,
        size: layers.records.byteLength,
        usage: UNIFORM_BUFFER_USAGE | COPY_DESTINATION_USAGE,
      });
    } catch (error) {
      throw new AllocationError(error);
    }
    try {
      this.#resources.track(recordsId, { category: 'buffer', size: layers.records.byteLength });
    } catch (error) {
      records.destroy();
      throw new AllocationError(error);
    }
    transients.push({ id: recordsId, resource: records });
    this.#device.queue.writeBuffer(records, 0, layers.records, 0, layers.records.byteLength);
    const texture = (
      name: string,
      width: number,
      height: number,
      format: GPUTextureFormat,
      sampleCount: number,
      bytesPerTexel: number,
      usage: number,
    ) => {
      const id = `${prefix}/${name}`;
      const created = this.#createTrackedTexture(
        id,
        width,
        height,
        format,
        sampleCount,
        bytesPerTexel,
        usage,
      );
      transients.push({ id, resource: created });
      return created;
    };
    const textures = layers.layers.map((layer, index) =>
      texture(
        `layer-${index}`,
        layer.bound.width,
        layer.bound.height,
        this.#format,
        1,
        4,
        TEXTURE_BINDING_USAGE | TEXTURE_COPY_DESTINATION_USAGE,
      ),
    );
    const { tileWidth, tileHeight } = layers;
    // V35-K4: under blend 'v0' a backdrop snapshot reads the tile colour attachment.
    const color = texture(
      'tile-color',
      tileWidth,
      tileHeight,
      this.#format,
      this.sampleCount,
      4,
      (this.sampleCount === 4 ? 0 : TEXTURE_COPY_SOURCE_USAGE) |
        (this.#blend === null ? 0 : TEXTURE_BINDING_USAGE),
    );
    const resolve =
      this.sampleCount === 4
        ? texture(
            'tile-resolve',
            tileWidth,
            tileHeight,
            this.#format,
            1,
            4,
            TEXTURE_COPY_SOURCE_USAGE,
          )
        : null;
    // Section 4: the tile's stencil exists exactly when the main pass has one.
    const stencil = this.#stencil
      ? texture('tile-stencil', tileWidth, tileHeight, MESH_STENCIL_FORMAT, this.sampleCount, 1, 0)
      : null;
    const passGroup = this.#device.createBindGroup({
      label: `${prefix}/pass-bind-group`,
      layout: pipelines.bindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: records, offset: 0, size: LAYER_PASS_RECORD_SIZE } },
      ],
    });
    // E41 U5: an effect root's `R`, which its composite draws instead of `L`.
    const results = layers.effects.map((effect, index) =>
      effect?.result == null
        ? null
        : texture(
            `effect-result-${index}`,
            effect.result.width,
            effect.result.height,
            this.#format,
            1,
            4,
            TEXTURE_BINDING_USAGE,
          ),
    );
    const scratch = layers.scratch.map((pair, slot) =>
      ([0, 1] as const).map((index) =>
        texture(
          `effect-scratch-${slot}-${index}`,
          pair.width,
          pair.height,
          this.#format,
          1,
          4,
          TEXTURE_BINDING_USAGE,
        ),
      ),
    );
    // V35-K4: each blend root's backdrop snapshot, filled by its splits before its composite.
    const snapshots = layers.blends.map((blend, index): BackdropSnapshot | null =>
      blend === null
        ? null
        : Object.freeze({
            texture: texture(
              `backdrop-${index}`,
              blend.snapshot.width,
              blend.snapshot.height,
              this.#format,
              1,
              4,
              TEXTURE_BINDING_USAGE,
            ),
            origin: Object.freeze({ x: blend.snapshot.x, y: blend.snapshot.y }),
          }),
    );
    const compositeGroups = textures.map((layerTexture, index) => {
      const snapshot = snapshots[index];
      const record = {
        buffer: records,
        offset: (layers.compositeRecordBase + index) * layers.stride,
        size: LAYER_COMPOSITE_RECORD_SIZE,
      };
      const layerView = (results[index] ?? layerTexture).createView();
      if (snapshot !== null && snapshot !== undefined) {
        // V35-K5: `R`, the blend record and the backdrop snapshot.
        return this.#device.createBindGroup({
          label: `${prefix}/blend-composite-${index}`,
          layout: this.#blend!.compositeBindGroupLayout,
          entries: [
            { binding: BLEND_COMPOSITE_BINDINGS.layer, resource: layerView },
            { binding: BLEND_COMPOSITE_BINDINGS.record, resource: record },
            { binding: BLEND_COMPOSITE_BINDINGS.backdrop, resource: snapshot.texture.createView() },
          ],
        });
      }
      return this.#device.createBindGroup({
        label: `${prefix}/composite-${index}`,
        layout: pipelines.compositeBindGroupLayout,
        entries: [
          { binding: LAYER_COMPOSITE_BINDINGS.layer, resource: layerView },
          { binding: LAYER_COMPOSITE_BINDINGS.record, resource: record },
        ],
      });
    });
    const skipped = new Set<number>();
    layers.effects.forEach((effect, index) => {
      if (effect !== null && effect.result === null) skipped.add(index);
    });
    const frame: LayerFrame = Object.freeze({
      passGroup,
      compositeGroups,
      compositeStates: layers.compositeStates,
      textures,
      skipped,
      snapshots: Object.freeze(snapshots),
      records,
    });
    const effectGroups = new Map<GPUTexture, GPUBindGroup>();
    const effectGroup = (source: GPUTexture) => {
      let group = effectGroups.get(source);
      if (group === undefined) {
        group = this.#device.createBindGroup({
          label: `${prefix}/effect-${effectGroups.size}`,
          layout: this.#effect!.bindGroupLayout,
          entries: [
            { binding: EFFECT_BINDINGS.source, resource: source.createView() },
            {
              binding: EFFECT_BINDINGS.record,
              resource: { buffer: records, offset: 0, size: EFFECT_PASS_RECORD_SIZE },
            },
          ],
        });
        effectGroups.set(source, group);
      }
      return group;
    };
    // E41 U5b: E25's draw set; layers in or of an effect root draw with the shifted one.
    const e25: LayerDrawPipelines = Object.freeze({
      ...pipelines,
      analytic: this.#pipeline,
      stencil: this.#mesh?.stencil ?? null,
      text: this.#text?.layer ?? null,
      textClip: this.#text?.clipLayer ?? null,
      compositeClip: this.#effect?.compositeClip ?? null,
      blendComposite: this.#blend?.plain ?? null,
      blendCompositeClip: this.#blend?.clip ?? null,
      fullLayouts: false,
    });
    const shiftedSet: LayerDrawPipelines | null =
      this.#effect === null
        ? null
        : Object.freeze({
            ...this.#effect.shifted,
            blendComposite: this.#blend?.shifted ?? null,
            blendCompositeClip: this.#blend?.clipShifted ?? null,
          });
    const colorView = color.createView();
    const resolveView = resolve?.createView();
    const stencilView = stencil?.createView();
    const copySource = resolve ?? color;
    // V35-K4: a snapshot in a tile pass reads the tile colour attachment.
    const tileParent =
      this.#blend === null || ![...layers.splits.keys()].some((key) => key !== '-1')
        ? null
        : this.#device.createBindGroup({
            label: `${prefix}/backdrop-tile-parent`,
            layout: this.#blend.snapshotBindGroupLayout,
            entries: [
              { binding: BACKDROP_SNAPSHOT_BINDINGS.parent, resource: colorView },
              {
                binding: BACKDROP_SNAPSHOT_BINDINGS.record,
                resource: { buffer: records, offset: 0, size: BACKDROP_SNAPSHOT_RECORD_SIZE },
              },
            ],
          });
    layers.layers.forEach((layer, index) => {
      layers.tiles[index]!.forEach((tile, tileIndex) => {
        const tileSplits = layers.splits.get(splitKey(index, tileIndex));
        // V35-K4: a pass ended before a snapshot stores colour and stencil (and resolves only
        // at its last segment); a resumed one loads them. Without splits, as E25 encodes it.
        let remaining = tileSplits?.size ?? 0;
        const begin = (resume: boolean) => {
          const last = remaining === 0;
          const next = encoder.beginRenderPass({
            label: `vector-studio/layer-pass/${index}`,
            colorAttachments: [
              {
                view: colorView,
                ...(resolveView === undefined || !last ? {} : { resolveTarget: resolveView }),
                clearValue: { r: 0, g: 0, b: 0, a: 0 },
                loadOp: resume ? 'load' : 'clear',
                storeOp: resolveView === undefined || !last ? 'store' : 'discard',
              },
            ],
            ...(stencilView === undefined
              ? {}
              : {
                  depthStencilAttachment: {
                    view: stencilView,
                    stencilClearValue: 0,
                    stencilLoadOp: resume ? 'load' : 'clear',
                    stencilStoreOp: last ? 'discard' : 'store',
                  },
                }),
          });
          if (shiftedPass) next.setViewport(0, 0, tileWidth, tileHeight, 0, 1);
          else {
            next.setViewport(
              -(layer.bound.x + tile.x),
              -(layer.bound.y + tile.y),
              target.width,
              target.height,
              0,
              1,
            );
          }
          return next;
        };
        const shiftedPass = layers.shifted[index]!;
        let pass = begin(false);
        const parent: BackdropParent | null =
          tileParent === null
            ? null
            : Object.freeze({
                pipeline: this.#blend!.snapshot,
                bindGroup: tileParent,
                region: {
                  x: layer.bound.x + tile.x,
                  y: layer.bound.y + tile.y,
                  width: tile.width,
                  height: tile.height,
                },
              });
        const split =
          tileSplits === undefined || parent === null
            ? null
            : (child: number) => {
                const planned = tileSplits.get(child);
                const snapshot = frame.snapshots[child];
                if (planned === undefined || snapshot == null) return null;
                pass.end();
                remaining -= 1;
                snapshotBackdrop(
                  encoder,
                  parent,
                  planned.rect,
                  0,
                  snapshot,
                  planned.record * layers.stride,
                );
                pass = begin(true);
                return pass;
              };
        const set = shiftedPass ? shiftedSet! : e25;
        this.#encodeLayerPassDraws(pass, frame, layers, index, tile.record * layers.stride, set, {
          arena,
          meshArena,
          clip,
          paint,
          textPart: text.part,
          split,
        });
        pass.end();
        encoder.copyTextureToTexture(
          { texture: copySource },
          { texture: textures[index]!, origin: { x: tile.x, y: tile.y } },
          { width: tile.width, height: tile.height },
        );
      });
      // E41 U5: `L` is complete; build `R` before any later pass composites it.
      const effect = layers.effects[index];
      if (effect == null || effect.result === null) return;
      const pair = scratch[effect.scratchSlot];
      const surfaces: Record<EffectSurface, GPUTexture | null> = {
        content: textures[index]!,
        result: results[index]!,
        scratch0: pair?.[0] ?? null,
        scratch1: pair?.[1] ?? null,
      };
      effect.plan.passes.forEach((planned, offset) => {
        const pass = encoder.beginRenderPass({
          label: `vector-studio/effect-pass/${index}/${planned.kind}`,
          colorAttachments: [
            {
              view: surfaces[planned.target]!.createView(),
              clearValue: { r: 0, g: 0, b: 0, a: 0 },
              loadOp: planned.clear ? 'clear' : 'load',
              storeOp: 'store',
            },
          ],
        });
        pass.setViewport(0, 0, planned.width, planned.height, 0, 1);
        pass.setPipeline(this.#effect!.pipelines.get(planned.kind)!);
        pass.setBindGroup(0, effectGroup(surfaces[planned.source]!), [
          (effect.recordBase + offset) * layers.stride,
        ]);
        pass.draw(3);
        pass.end();
      });
    });
    return frame;
  }

  /**
   * E25 section 4: one layer tile pass's draws, in the layer's paint order with its children's
   * composites. A draw that reads its position uses its layer variant; an unclipped solid
   * analytic run uses the base pipeline. Groups 1 and 2 are bound for each variant's layout (the
   * clip group or the empty group; the paint group or the empty group). Unavailable variants
   * fail closed, as in the main pass, and E17's write-once references restart in each pass.
   */
  #encodeLayerPassDraws(
    firstPass: GPURenderPassEncoder,
    frame: LayerFrame,
    layers: NonNullable<ValidatedLayers>,
    index: number,
    passOffset: number,
    set: LayerDrawPipelines,
    env: Readonly<{
      arena: ArenaState;
      meshArena: MeshArenaState | null;
      clip: ValidatedClip;
      paint: ValidatedPaint;
      /** E28 U3: the frame's text part when its draws are encoded, otherwise null. */
      textPart: TextPacketPart | null;
      /**
       * V35-K4: ends the pass before a blend root's composite, takes its snapshot and returns
       * the resumed pass; null when that root has no split in this pass.
       */
      split?: ((layer: number) => GPURenderPassEncoder | null) | null;
    }>,
  ): void {
    let pass = firstPass;
    const pipelines = this.#layer!;
    const draws = layers.layers[index]!.draws;
    const stencilPipelines = set.stencil;
    const meshDraws = layers.meshDraws[index]!;
    const slots = layers.slots.get(index) ?? [];
    const { arena, meshArena, clip, paint, textPart } = env;
    const paintBuffers = paint === null ? null : this.#paintBuffers!;
    let pipeline: GPURenderPipeline | null = null;
    let group0: string | null = null;
    let group1: number | null = null;
    let group2: string | null = null;
    const usePipeline = (next: GPURenderPipeline) => {
      if (pipeline === next) return;
      pass.setPipeline(next);
      pipeline = next;
    };
    const bind0 = (kind: 'analytic' | 'mesh') => {
      if (group0 === kind) return;
      if (kind === 'analytic') {
        pass.setBindGroup(0, arena.bindGroup);
        pass.setVertexBuffer(0, this.#vertexBuffer, 0, 32);
        pass.setIndexBuffer(this.#indexBuffer, 'uint16', 0, 12);
      } else {
        pass.setBindGroup(0, meshArena!.bindGroup);
      }
      group0 = kind;
    };
    const bind1 = (state: number) => {
      if (group1 === state) return;
      if (state === 0) pass.setBindGroup(CLIP_BIND_GROUP_INDEX, pipelines.emptyBindGroup);
      else {
        pass.setBindGroup(CLIP_BIND_GROUP_INDEX, this.#clipBindGroup(clip!, state), [
          state * clip!.stride,
        ]);
      }
      group1 = state;
    };
    const bind2 = (kind: 'empty' | 'analytic' | 'mesh') => {
      if (group2 === kind) return;
      pass.setBindGroup(
        PAINT_BIND_GROUP_INDEX,
        kind === 'empty'
          ? pipelines.emptyBindGroup
          : kind === 'analytic'
            ? paintBuffers!.primitiveBindGroup
            : paintBuffers!.meshBindGroup,
      );
      group2 = kind;
    };
    pass.setBindGroup(LAYER_BIND_GROUP_INDEX, frame.passGroup, [passOffset]);
    // E28 section 4: slot k at a position holds the composite or text draw whose order is k,
    // otherwise the next mesh draw. A text draw uses its layer variant, with the clip group or
    // the empty group at 1 and the empty group at 2.
    let nextSlot = 0;
    const drawSlot = (slot: OrderSlot) => {
      if (slot.text !== null) {
        if (textPart === null) return;
        const draw = textPart.draws[slot.text]!;
        const state = draw.clipState ?? 0;
        const variant = state === 0 ? set.text : set.textClip;
        if (variant === null || (state !== 0 && clip === null)) return;
        usePipeline(variant);
        pass.setBindGroup(0, this.#textBindGroup(draw.page));
        group0 = null;
        bind1(state);
        bind2('empty');
        pass.draw(6, draw.count, 0, draw.first);
        return;
      }
      if (slot.layer === null) return;
      const resumed = env.split?.(slot.layer) ?? null;
      if (resumed !== null) {
        // The resumed pass has no state: the layer group is bound again, the rest on demand.
        pass = resumed;
        pass.setBindGroup(LAYER_BIND_GROUP_INDEX, frame.passGroup, [passOffset]);
      }
      const state = this.#encodeComposite(
        pass,
        frame,
        slot.layer,
        passOffset,
        clip,
        set.composite,
        set.compositeClip,
        set.blendComposite ?? null,
        set.blendCompositeClip ?? null,
      );
      // Unknown after a composite: the next draw sets its pipeline and groups.
      pipeline = null;
      group0 = null;
      group1 = state;
      group2 = state === -1 ? null : 'empty';
    };
    let nextMeshDraw = 0;
    // E39-R5, R7: the layer tile pass's own stencil sequence.
    const sequence = new MeshStencilSequence();
    const drawMeshesAt = (position: number) => {
      let order = 0;
      for (;;) {
        const slot = slots[nextSlot];
        if (slot !== undefined && slot.position === position && slot.order === order) {
          drawSlot(slot);
          nextSlot += 1;
          order += 1;
          continue;
        }
        if (meshDraws[nextMeshDraw]?.position !== position) break;
        order += 1;
        const draw = meshDraws[nextMeshDraw]!;
        const coverage = draw.coverage;
        const step = coverage === undefined ? sequence.partition() : null;
        nextMeshDraw += 1;
        if (step === null ? sequence.winding() : step.reset) {
          usePipeline(this.#mesh!.resetPipeline);
          pass.draw(3);
        }
        const state = draw.clipState ?? 0;
        const joint = coverage === undefined && draw.composite === 'joint-fill';
        // E39-R6, R7: a joint pair draws as in the main pass, with the layer variant's covers.
        const jointStroke =
          coverage !== undefined && draw.composite === 'joint-fill'
            ? meshDraws[nextMeshDraw]!
            : null;
        if (jointStroke !== null) {
          nextMeshDraw += 1;
          order += 1;
        }
        const painted =
          draw.gradient !== undefined ||
          draw.strokeGradient !== undefined ||
          jointStroke?.gradient !== undefined;
        if (state !== 0 && clip === null) continue;
        if (painted && paint === null) continue;
        if (jointStroke !== null) {
          const covers = painted
            ? state === 0
              ? set.meshCoverPaint
              : set.meshCoverPaintClip
            : state === 0
              ? set.meshCover
              : set.meshCoverClip;
          if (covers === null || stencilPipelines === null) continue;
          // encodeMeshJoint sets each step's pipeline; group 0 may be set before it, and the
          // stencil passes of the shifted set take the empty groups (their covers bind theirs).
          bind0('mesh');
          if (set.fullLayouts) {
            bind1(0);
            bind2('empty');
          }
          encodeMeshJoint(
            pass,
            draw,
            jointStroke,
            meshCoverRule(draw),
            (kind) => stencilPipelines[kind],
            (cover) => covers[cover],
            () => {
              bind1(state);
              bind2(painted ? 'mesh' : 'empty');
            },
          );
          // encodeMeshJoint set pipelines directly; the next draw sets its own again.
          pipeline = null;
          continue;
        }
        if (coverage !== undefined) {
          // E39-R7: R1 and R2 with the layer variant's cover.
          const covers = painted
            ? state === 0
              ? set.meshCoverPaint
              : set.meshCoverPaintClip
            : state === 0
              ? set.meshCover
              : set.meshCoverClip;
          if (covers === null || stencilPipelines === null) continue;
          const stencilTriangles = draw.triangleCount - 2;
          usePipeline(stencilPipelines[coverage]);
          bind0('mesh');
          if (set.fullLayouts) {
            bind1(0);
            bind2('empty');
          }
          pass.setStencilReference(meshStencilPassReference(coverage));
          pass.draw(3 * stencilTriangles, 1, 3 * draw.firstTriangle, draw.instance);
          usePipeline(covers[meshCoverRule(draw)]);
          bind1(state);
          bind2(painted ? 'mesh' : 'empty');
          pass.setStencilReference(0);
          pass.draw(6, 1, 3 * (draw.firstTriangle + stencilTriangles), draw.instance);
          continue;
        }
        const variant = painted
          ? state === 0
            ? joint
              ? set.meshJointPaint
              : set.meshPaint
            : joint
              ? set.meshJointPaintClip
              : set.meshPaintClip
          : state === 0
            ? joint
              ? set.meshJoint
              : set.mesh
            : joint
              ? set.meshJointClip
              : set.meshClip;
        if (variant === null) continue;
        usePipeline(variant);
        bind0('mesh');
        bind1(state);
        bind2(painted ? 'mesh' : 'empty');
        pass.setStencilReference(step!.reference);
        pass.draw(3 * draw.triangleCount, 1, 3 * draw.firstTriangle, draw.instance);
      }
      while (slots[nextSlot]?.position === position) drawSlot(slots[nextSlot++]!);
    };
    draws.forEach((draw, position) => {
      drawMeshesAt(position);
      const state = draw.clipState ?? 0;
      const painted = draw.paint === 'gradient';
      if (state !== 0 && clip === null) return;
      if (painted && paint === null) return;
      const variant = painted
        ? state === 0
          ? set.analyticPaint
          : set.analyticPaintClip
        : state === 0
          ? set.analytic
          : set.analyticClip;
      if (variant === null) return;
      usePipeline(variant);
      bind0('analytic');
      if (variant !== set.analytic || set.fullLayouts) {
        bind1(state);
        bind2(painted ? 'analytic' : 'empty');
      }
      pass.drawIndexed(6, draw.count, 0, 0, draw.first);
    });
    drawMeshesAt(draws.length);
  }

  /**
   * E25 section 4, Composite pipeline: the child layer's quad, at the pass's record. E41-K2b: an
   * effect root's composite with a clip state uses the effect composite's clip variant
   * (`compositeClip`), with the state's clip group; without it the root is not drawn (fail
   * closed, as a clipped draw without the clip variants). Returns the clip state bound at group 1.
   */
  #encodeComposite(
    pass: GPURenderPassEncoder,
    frame: LayerFrame,
    layer: number,
    passOffset: number,
    clip: ValidatedClip,
    composite: GPURenderPipeline = this.#layer!.composite,
    compositeClip: GPURenderPipeline | null = this.#effect?.compositeClip ?? null,
    blendComposite: GPURenderPipeline | null = this.#blend?.plain ?? null,
    blendCompositeClip: GPURenderPipeline | null = this.#blend?.clip ?? null,
  ): number {
    if (frame.skipped.has(layer)) return -1;
    const state = frame.compositeStates[layer] ?? 0;
    // V35-K5: a blend root with its snapshot draws through the blend composite (preflight
    // checked that this pass and clip state have their variant).
    const blended = frame.snapshots[layer] != null;
    const plain = blended ? blendComposite : composite;
    const clipped = blended ? blendCompositeClip : compositeClip;
    if (plain === null || (state !== 0 && (clipped === null || clip === null))) return -1;
    const pipelines = this.#layer!;
    pass.setPipeline(state === 0 ? plain : clipped!);
    pass.setBindGroup(0, frame.compositeGroups[layer]!);
    if (state === 0) pass.setBindGroup(CLIP_BIND_GROUP_INDEX, pipelines.emptyBindGroup);
    else {
      pass.setBindGroup(CLIP_BIND_GROUP_INDEX, this.#clipBindGroup(clip!, state), [
        state * clip!.stride,
      ]);
    }
    pass.setBindGroup(PAINT_BIND_GROUP_INDEX, pipelines.emptyBindGroup);
    pass.setBindGroup(LAYER_BIND_GROUP_INDEX, frame.passGroup, [passOffset]);
    pass.draw(6);
    return state;
  }

  /** Destroys the frame's transient attachments and releases their accounting entries. */
  #releaseTransients(transients: Transient[]): void {
    for (const transient of transients.splice(0)) {
      try {
        try {
          transient.resource.destroy();
        } finally {
          this.#resources.release(transient.id);
        }
      } catch {
        // Accounting cleanup is best effort.
      }
    }
  }

  /** Destroys the clip buffer and its accounting entry; a later clipped frame creates one. */
  #releaseClipBuffer(): void {
    const buffer = this.#clipBuffer;
    if (buffer === undefined) return;
    this.#clipBuffer = undefined;
    try {
      buffer.buffer.destroy();
    } finally {
      this.#resources.release(buffer.id);
    }
  }

  #clipStride(): number {
    const alignment = this.#device.limits.minUniformBufferOffsetAlignment;
    if (typeof alignment !== 'number' || !isPowerOfTwo(alignment)) throw new AllocationError();
    return clipStateStride(alignment);
  }

  #createClipBuffer(capacity: number, stride: number): ClipBufferState {
    const size = (capacity + 1) * stride;
    if (size > safeLimit(this.#device.limits.maxBufferSize, 0)) throw new AllocationError();
    const id = `primitive/${this.#generation}/clip-states-${this.#nextClipBuffer++}`;
    let buffer: GPUBuffer;
    try {
      buffer = this.#device.createBuffer({
        label: id,
        size,
        usage: UNIFORM_BUFFER_USAGE | COPY_DESTINATION_USAGE,
      });
    } catch (error) {
      throw new AllocationError(error);
    }
    try {
      this.#resources.track(id, { category: 'buffer', size });
    } catch (error) {
      buffer.destroy();
      throw new AllocationError(error);
    }
    let bindGroup: GPUBindGroup;
    try {
      bindGroup = this.#device.createBindGroup({
        label: `${id}/bind-group`,
        layout: this.#clip!.bindGroupLayout,
        entries: [
          {
            binding: CLIP_BINDINGS.frame,
            resource: { buffer, offset: 0, size: CLIP_FRAME_SIZE },
          },
          {
            binding: CLIP_BINDINGS.state,
            resource: { buffer, offset: 0, size: CLIP_STATE_SIZE },
          },
          { binding: CLIP_BINDINGS.mask, resource: this.#clip!.defaultMask.createView() },
        ],
      });
    } catch (error) {
      buffer.destroy();
      this.#resources.release(id);
      throw new AllocationError(error);
    }
    return { id, buffer, bindGroup, capacity, written: new Map(), frame: null };
  }

  /** U4: a mask level's bind group, over the clip buffer and the level's texture. */
  #maskBindGroup(buffer: ClipBufferState, entry: MaskEntry): GPUBindGroup {
    return this.#device.createBindGroup({
      label: `${entry.id}/bind-group`,
      layout: this.#clip!.bindGroupLayout,
      entries: [
        {
          binding: CLIP_BINDINGS.frame,
          resource: { buffer: buffer.buffer, offset: 0, size: CLIP_FRAME_SIZE },
        },
        {
          binding: CLIP_BINDINGS.state,
          resource: { buffer: buffer.buffer, offset: 0, size: CLIP_STATE_SIZE },
        },
        { binding: CLIP_BINDINGS.mask, resource: entry.texture.createView() },
      ],
    });
  }

  /**
   * Writes the frame lanes and the state records whose bytes changed (P4-A06), and adopts a
   * new buffer, releasing the previous one; queue order keeps earlier submissions' contents.
   */
  #writeClip(clip: NonNullable<ValidatedClip>): void {
    const target = clip.buffer;
    if (clip.createdBuffer) {
      const previous = this.#clipBuffer;
      this.#clipBuffer = target;
      if (previous !== undefined) {
        try {
          previous.buffer.destroy();
        } finally {
          this.#resources.release(previous.id);
        }
      }
    }
    for (const mask of clip.masks) {
      if (mask.entry.bindGroupBuffer === target.id) continue;
      mask.entry.bindGroup = this.#maskBindGroup(target, mask.entry);
      mask.entry.bindGroupBuffer = target.id;
    }
    if (target.frame === null || !bytesEqual(target.frame, clip.frame)) {
      this.#device.queue.writeBuffer(target.buffer, 0, clip.frame, 0, clip.frame.byteLength);
      target.frame = clip.frame;
    }
    for (const [index, bytes] of clip.states) {
      const written = target.written.get(index);
      if (written !== undefined && bytesEqual(written, bytes)) continue;
      this.#device.queue.writeBuffer(
        target.buffer,
        index * clip.stride,
        bytes,
        0,
        bytes.byteLength,
      );
      target.written.set(index, bytes);
      this.clipStateWritesForTesting += 1;
    }
  }

  /**
   * E23 contract, U3: checks the paint part against the draws that will be encoded and packs
   * the records and index tables; creates nothing. A primitive run marked `paint` or a mesh
   * draw with `gradient` or `strokeGradient` needs the part; every index must name a record of
   * it (or be 0 in an index table), each primitive entry a written slot, and a `strokeGradient`
   * only a joint fill draw. A part without a gradient draw, or a scene without the paint
   * variants, is checked and writes nothing: its gradient draws are not drawn.
   */
  #preflightPaint(
    packet: PrimitivePacket,
    analyticDraws: readonly PrimitiveDraw[],
    meshDraws: readonly MeshFillDraw[],
    validated: ValidatedPacket,
  ): ValidatedPaint {
    let used = false;
    for (const draw of analyticDraws) {
      const flag: unknown = draw.paint;
      if (flag === undefined) continue;
      if (flag !== 'gradient') throw new Error('Invalid paint flag.');
      used = true;
    }
    const isIndex = (value: unknown): value is number =>
      typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
    for (const draw of meshDraws) {
      const fill: unknown = draw.gradient;
      const stroke: unknown = draw.strokeGradient;
      if (fill === undefined && stroke === undefined) continue;
      if (
        (fill !== undefined && !(isIndex(fill) && fill > 0)) ||
        (stroke !== undefined && !(isIndex(stroke) && stroke > 0)) ||
        (stroke !== undefined && draw.composite !== 'joint-fill')
      ) {
        throw new Error('Invalid mesh paint index.');
      }
      used = true;
    }
    const part = packet.paint;
    if (part === undefined) {
      if (used) throw new Error('A gradient draw without a paint part.');
      return null;
    }
    if (
      typeof part !== 'object' ||
      part === null ||
      part.layoutVersion !== 0 ||
      !isArrayValue(part.records) ||
      !isArrayValue(part.primitives)
    ) {
      throw new Error('Invalid paint part.');
    }
    const count = part.records.length;
    const primitives = new Map<number, readonly [number, number]>();
    for (const entry of part.primitives as readonly unknown[]) {
      const value = entry as Partial<{ slot: unknown; fill: unknown; stroke: unknown }> | null;
      if (
        typeof value !== 'object' ||
        value === null ||
        !isIndex(value.slot) ||
        !isIndex(value.fill) ||
        !isIndex(value.stroke) ||
        value.fill > count ||
        value.stroke > count ||
        primitives.has(value.slot) ||
        !validated.initialized.styles.has(value.slot)
      ) {
        throw new Error('Invalid primitive paint entry.');
      }
      primitives.set(value.slot, [value.fill, value.stroke]);
    }
    const meshes = new Map<number, readonly [number, number]>();
    for (const draw of meshDraws) {
      if (draw.gradient === undefined && draw.strokeGradient === undefined) continue;
      const pair = [draw.gradient ?? 0, draw.strokeGradient ?? 0] as const;
      const previous = meshes.get(draw.instance);
      if (
        pair[0] > count ||
        pair[1] > count ||
        (previous !== undefined && (previous[0] !== pair[0] || previous[1] !== pair[1]))
      ) {
        throw new Error('Invalid mesh paint index.');
      }
      meshes.set(draw.instance, pair);
    }
    const records = part.records.map((record) => {
      const cached =
        typeof record === 'object' && record !== null
          ? this.#paintRecordBytes.get(record)
          : undefined;
      if (cached !== undefined) return cached;
      const bytes = packGradientRecord(record);
      if (bytes === null) throw new Error('Unsupported gradient record.');
      this.#paintRecordBytes.set(record, bytes);
      return bytes;
    });
    if (this.#paint === null || !used) return null;
    return Object.freeze({
      records,
      primitives: packPaintIndices(primitives),
      meshes: packPaintIndices(meshes),
    });
  }

  /**
   * E23 U3: grows a paint table that is too small (a new buffer, the old one released; queue
   * order keeps earlier submissions' contents), then writes the records and index tables whose
   * bytes changed, so a frame that rebuilt no record writes none (E23-A05).
   */
  #writePaint(paint: NonNullable<ValidatedPaint>): void {
    const current = this.#paintBuffers;
    const recordsSize = (paint.records.length + 1) * GRADIENT_RECORD_SIZE;
    const fits = (table: PaintTable | undefined, size: number) =>
      table !== undefined && table.size >= size;
    let state = current;
    if (
      state === undefined ||
      !fits(state.records, recordsSize) ||
      !fits(state.primitives, paint.primitives.byteLength) ||
      !fits(state.meshes, paint.meshes.byteLength)
    ) {
      const created: PaintTable[] = [];
      try {
        const table = (name: string, previous: PaintTable | undefined, size: number) => {
          if (fits(previous, size)) return previous!;
          const next = this.#createPaintTable(name, size);
          created.push(next);
          return next;
        };
        const records = table('paint-records', current?.records, recordsSize);
        const primitives = table(
          'paint-primitives',
          current?.primitives,
          paint.primitives.byteLength,
        );
        const meshes = table('paint-meshes', current?.meshes, paint.meshes.byteLength);
        const group = (indices: PaintTable, name: string) =>
          this.#device.createBindGroup({
            label: `${indices.id}/${name}`,
            layout: this.#paint!.bindGroupLayout,
            entries: [
              { binding: PAINT_BINDINGS.gradients, resource: { buffer: records.buffer } },
              { binding: PAINT_BINDINGS.indices, resource: { buffer: indices.buffer } },
            ],
          });
        state = {
          records,
          primitives,
          meshes,
          primitiveBindGroup: group(primitives, 'bind-group'),
          meshBindGroup: group(meshes, 'bind-group'),
          written: records === current?.records ? current.written : new Map<number, Uint8Array>(),
          primitiveBytes: primitives === current?.primitives ? current.primitiveBytes : null,
          meshBytes: meshes === current?.meshes ? current.meshBytes : null,
        };
      } catch (error) {
        for (const table of created) this.#releasePaintTable(table);
        throw error instanceof AllocationError ? error : new AllocationError(error);
      }
      this.#paintBuffers = state;
      for (const table of [current?.records, current?.primitives, current?.meshes]) {
        if (table !== undefined && !this.#paintTableInUse(table)) {
          this.#releasePaintTable(table);
        }
      }
    }
    for (const [position, bytes] of paint.records.entries()) {
      const index = position + 1;
      if (state.written.get(index) === bytes) continue;
      this.#device.queue.writeBuffer(
        state.records.buffer,
        index * GRADIENT_RECORD_SIZE,
        bytes,
        0,
        bytes.byteLength,
      );
      state.written.set(index, bytes);
      this.paintRecordWritesForTesting += 1;
    }
    if (state.primitiveBytes === null || !bytesEqual(state.primitiveBytes, paint.primitives)) {
      this.#device.queue.writeBuffer(state.primitives.buffer, 0, paint.primitives);
      state.primitiveBytes = paint.primitives;
    }
    if (state.meshBytes === null || !bytesEqual(state.meshBytes, paint.meshes)) {
      this.#device.queue.writeBuffer(state.meshes.buffer, 0, paint.meshes);
      state.meshBytes = paint.meshes;
    }
  }

  #paintTableInUse(table: PaintTable): boolean {
    const state = this.#paintBuffers;
    return (
      state !== undefined &&
      (state.records === table || state.primitives === table || state.meshes === table)
    );
  }

  #createPaintTable(name: string, minimum: number): PaintTable {
    const size = nextPowerOfTwo(minimum);
    if (size > safeLimit(this.#device.limits.maxBufferSize, 0)) throw new AllocationError();
    if (size > safeLimit(this.#device.limits.maxStorageBufferBindingSize, 0)) {
      throw new AllocationError();
    }
    const id = `primitive/${this.#generation}/${name}-${this.#nextPaintBuffer++}`;
    let buffer: GPUBuffer;
    try {
      buffer = this.#device.createBuffer({
        label: id,
        size,
        usage: STORAGE_BUFFER_USAGE | COPY_DESTINATION_USAGE,
      });
    } catch (error) {
      throw new AllocationError(error);
    }
    try {
      this.#resources.track(id, { category: 'buffer', size });
    } catch (error) {
      buffer.destroy();
      throw new AllocationError(error);
    }
    return { id, buffer, size };
  }

  #releasePaintTable(table: PaintTable): void {
    try {
      table.buffer.destroy();
    } finally {
      this.#resources.release(table.id);
    }
  }

  /** Destroys the paint buffers and their accounting entries; a later gradient frame creates them. */
  #releasePaintBuffers(): void {
    const state = this.#paintBuffers;
    if (state === undefined) return;
    this.#paintBuffers = undefined;
    let firstError: unknown;
    for (const table of [state.records, state.primitives, state.meshes]) {
      try {
        this.#releasePaintTable(table);
      } catch (error) {
        firstError ??= error;
      }
    }
    if (firstError !== undefined) throw asError(firstError, 'Paint buffer release failed.');
  }

  #preflight(packet: PrimitivePacket): ValidatedPacket {
    if (
      packet.layoutVersion !== PRIMITIVE_PACKET_LAYOUT_VERSION ||
      this.#target === null ||
      !targetEquals(packet.frame, this.#target) ||
      packet.surfaceRevision !== this.#target.surfaceRevision ||
      !Number.isSafeInteger(packet.generation) ||
      typeof packet.sceneEpoch !== 'symbol' ||
      typeof packet.originRevision !== 'symbol' ||
      typeof packet.packetId !== 'symbol' ||
      (packet.mode !== 'reconstruct' && packet.mode !== 'incremental') ||
      typeof packet.scene !== 'object' ||
      packet.scene === null ||
      typeof packet.scene.identity !== 'object' ||
      packet.scene.identity === null ||
      typeof packet.scene.identity.documentId !== 'string' ||
      packet.scene.identity.documentId.length === 0 ||
      typeof packet.scene.identity.pageId !== 'string' ||
      packet.scene.identity.pageId.length === 0 ||
      !Number.isSafeInteger(packet.scene.revision) ||
      packet.scene.revision < 0 ||
      packet.cameraRevision < 0 ||
      !Number.isSafeInteger(packet.cameraRevision) ||
      !isArrayValue(packet.resources) ||
      !isArrayValue(packet.writes) ||
      !isArrayValue(packet.draws) ||
      packet.resources.length !== RESOURCE_ORDER.length
    ) {
      throw new TypeError('Invalid primitive packet envelope.');
    }

    const capacities = {} as Record<PrimitiveResourceId, number>;
    const incarnations = {} as Record<PrimitiveResourceId, symbol>;
    for (let index = 0; index < RESOURCE_ORDER.length; index += 1) {
      const id = RESOURCE_ORDER[index];
      const resource = packet.resources[index];
      if (
        id === undefined ||
        resource === undefined ||
        resource.id !== id ||
        typeof resource.incarnation !== 'symbol' ||
        !isPositiveSafeInteger(resource.capacityBytes) ||
        resource.capacityBytes % RESOURCE_STRIDES[id] !== 0 ||
        (id === 'frame' && resource.capacityBytes !== PRIMITIVE_FRAME_SIZE)
      ) {
        throw new TypeError('Invalid primitive resource descriptor.');
      }
      capacities[id] = resource.capacityBytes;
      incarnations[id] = resource.incarnation;
    }
    const primitiveSlots = capacities.transforms / PRIMITIVE_TRANSFORM_STRIDE;
    const orderSlots = capacities.order / PRIMITIVE_ORDER_STRIDE;
    if (
      primitiveSlots < 16 ||
      !isPowerOfTwo(primitiveSlots) ||
      capacities.geometry / PRIMITIVE_GEOMETRY_STRIDE !== primitiveSlots ||
      capacities.styles / PRIMITIVE_STYLE_STRIDE !== primitiveSlots ||
      orderSlots < 16 ||
      !isPowerOfTwo(orderSlots)
    ) {
      throw new TypeError('Primitive resource capacities are inconsistent.');
    }
    this.#validateCapabilities(capacities);

    const current = this.#currentArena;
    const backingMatches =
      current !== undefined &&
      RESOURCE_ORDER.every(
        (id) =>
          current.incarnations[id] === incarnations[id] &&
          current.capacities[id] === capacities[id],
      );
    const requiresReconstruct = !backingMatches || current?.sceneEpoch !== packet.sceneEpoch;
    const reconstruct = packet.mode === 'reconstruct';
    if (requiresReconstruct && !reconstruct) {
      throw new TypeError('Primitive packet reconstruction mode is inconsistent.');
    }

    const writeRecords = new Map<PrimitiveResourceId, PrimitiveRecordVersion[]>();
    for (const id of RESOURCE_ORDER) writeRecords.set(id, []);
    let previousResource = -1;
    let previousEnd = 0;
    let initialized: Record<'transforms' | 'geometry' | 'styles', ReadonlySet<number>> = reconstruct
      ? { transforms: new Set(), geometry: new Set(), styles: new Set() }
      : current!.initialized;
    let order: Map<number, number> = reconstruct
      ? new Map<number, number>()
      : (current?.order as Map<number, number>);
    let orderCopied = reconstruct;
    let frameInitialized = reconstruct ? false : (current?.frameInitialized ?? false);

    for (const write of packet.writes) {
      const resourceId = write.resourceId;
      const resourceIndex = RESOURCE_ORDER.indexOf(resourceId);
      if (
        resourceIndex < 0 ||
        write.incarnation !== incarnations[resourceId] ||
        !Number.isSafeInteger(write.byteOffset) ||
        write.byteOffset < 0 ||
        write.byteOffset % 4 !== 0 ||
        !(write.bytes instanceof Uint8Array) ||
        write.bytes.byteLength === 0 ||
        write.bytes.byteLength % 4 !== 0 ||
        write.byteOffset + write.bytes.byteLength > capacities[resourceId] ||
        resourceIndex < previousResource ||
        (resourceIndex === previousResource && write.byteOffset < previousEnd)
      ) {
        throw new TypeError('Invalid primitive write range.');
      }
      previousResource = resourceIndex;
      previousEnd = write.byteOffset + write.bytes.byteLength;
      const stride = RESOURCE_STRIDES[resourceId];
      const firstIndex = write.byteOffset / stride;
      if (
        !Number.isInteger(firstIndex) ||
        write.bytes.byteLength % stride !== 0 ||
        write.records.length !== write.bytes.byteLength / stride
      ) {
        throw new TypeError('Primitive write records do not cover the write range.');
      }
      for (let offset = 0; offset < write.records.length; offset += 1) {
        const record = write.records[offset];
        if (
          record === undefined ||
          record.index !== firstIndex + offset ||
          typeof record.version !== 'symbol'
        ) {
          throw new TypeError('Invalid primitive record receipt.');
        }
        writeRecords.get(resourceId)?.push(Object.freeze({ ...record }));
      }
      if (
        write.resourceId === 'transforms' ||
        write.resourceId === 'geometry' ||
        write.resourceId === 'styles'
      ) {
        const instanceResource = resourceId as 'transforms' | 'geometry' | 'styles';
        if (
          write.records.some(
            (record: PrimitiveRecordVersion) => !initialized[instanceResource].has(record.index),
          )
        ) {
          const resourceRecords = new Set(initialized[instanceResource]);
          for (const record of write.records) resourceRecords.add(record.index);
          initialized = { ...initialized, [instanceResource]: resourceRecords };
        }
      } else if (write.resourceId === 'order') {
        if (!orderCopied) {
          order = new Map(order);
          orderCopied = true;
        }
        const values = new Uint32Array(
          write.bytes.buffer,
          write.bytes.byteOffset,
          write.bytes.byteLength / PRIMITIVE_ORDER_STRIDE,
        );
        for (let offset = 0; offset < values.length; offset += 1) {
          order.set(firstIndex + offset, values[offset] as number);
        }
      } else {
        if (firstIndex !== 0 || write.records.length !== 1)
          throw new TypeError('Invalid frame write.');
        frameInitialized = true;
      }
    }

    if (reconstruct && !sameSet(initialized.transforms, initialized.geometry, initialized.styles)) {
      throw new TypeError('Reconstruction initialized slot sets differ.');
    }
    if (!frameInitialized) throw new TypeError('Frame data is uninitialized.');
    // E25 contract, U3: the main pass's runs and every layer's runs together cover the order
    // stream's first entries exactly once; each target's runs are in order.
    const ranges: (readonly [number, number])[] = [];
    for (const draws of [packet.draws, ...packetLayers(packet).map((layer) => layer.draws)]) {
      let previousEnd = 0;
      for (const draw of draws) {
        if (
          draw.variant !== 'analytic-v1' ||
          !Number.isSafeInteger(draw.first) ||
          !Number.isSafeInteger(draw.count) ||
          draw.first < previousEnd ||
          draw.count <= 0
        ) {
          throw new TypeError('Invalid primitive draw range.');
        }
        previousEnd = draw.first + draw.count;
        ranges.push([draw.first, draw.count]);
      }
    }
    ranges.sort((left, right) => left[0] - right[0]);
    let expectedFirst = 0;
    for (const [first, count] of ranges) {
      if (first !== expectedFirst) throw new TypeError('Invalid primitive draw range.');
      expectedFirst += count;
    }
    if (expectedFirst * PRIMITIVE_ORDER_STRIDE > capacities.order) {
      throw new TypeError('Primitive draw exceeds order capacity.');
    }
    for (let index = 0; index < expectedFirst; index += 1) {
      const slot = order.get(index);
      if (
        slot === undefined ||
        !initialized.transforms.has(slot) ||
        !initialized.geometry.has(slot) ||
        !initialized.styles.has(slot)
      ) {
        throw new TypeError('Primitive order references an uninitialized slot.');
      }
    }

    let arena = current;
    let createdArena = false;
    if (!backingMatches) {
      arena = this.#createArena(capacities, incarnations);
      createdArena = true;
    }
    if (arena === undefined) throw new AllocationError();
    return Object.freeze({
      arena,
      createdArena,
      initialized: Object.freeze(initialized),
      order,
      frameInitialized,
      receiptResources: Object.freeze(
        RESOURCE_ORDER.map((resourceId) =>
          Object.freeze({
            resourceId,
            incarnation: incarnations[resourceId],
            records: Object.freeze(writeRecords.get(resourceId) ?? []),
          }),
        ),
      ),
    });
  }

  /**
   * P3 V3 section f. A part with no resources carries notices only. Otherwise the six resources
   * come in fixed order; writes follow P1's write rules; every draw has a valid position, an
   * initialized instance and a nonempty triangle range inside the meshTriangles capacity.
   */
  #preflightMesh(
    part: MeshPacketPart,
    analyticDraws: number,
    maskDraws: readonly MaskSourceDraw[] = [],
    layerDraws: readonly Readonly<{ draws: readonly MeshFillDraw[]; analyticDraws: number }>[] = [],
  ): ValidatedMesh {
    if (
      typeof part !== 'object' ||
      part === null ||
      part.layoutVersion !== MESH_PACKET_LAYOUT_VERSION ||
      typeof part.originRevision !== 'symbol' ||
      !isArrayValue(part.resources) ||
      !isArrayValue(part.writes) ||
      !isArrayValue(part.draws) ||
      !isArrayValue(part.notices)
    ) {
      throw new TypeError('Invalid mesh packet part.');
    }
    // The mesh path is unavailable for this generation: skip mesh writes and draws.
    if (this.#mesh === null) return Object.freeze({ skipped: true as const });
    if (part.resources.length === 0) {
      if (
        part.writes.length !== 0 ||
        part.draws.length !== 0 ||
        layerDraws.some((layer) => layer.draws.length !== 0)
      ) {
        throw new TypeError('A mesh part without resources carries notices only.');
      }
      return Object.freeze({
        skipped: false as const,
        arena: null,
        createdArena: false,
        instances: new Set<number>(),
        links: new Map<number, number>(),
        frameInitialized: false,
        draws: Object.freeze([]),
        receiptResources: Object.freeze([]),
      });
    }
    if (part.resources.length !== MESH_RESOURCE_IDS.length) {
      throw new TypeError('Invalid mesh resource list.');
    }
    const capacities = {} as Record<MeshResourceId, number>;
    const incarnations = {} as Record<MeshResourceId, symbol>;
    MESH_RESOURCE_IDS.forEach((id, index) => {
      const resource = part.resources[index];
      if (
        resource === undefined ||
        resource.id !== id ||
        typeof resource.incarnation !== 'symbol' ||
        !isPositiveSafeInteger(resource.capacityBytes) ||
        resource.capacityBytes % MESH_RESOURCE_STRIDES[id] !== 0 ||
        (id === 'meshFrame' && resource.capacityBytes !== MESH_FRAME_SIZE)
      ) {
        throw new TypeError('Invalid mesh resource descriptor.');
      }
      capacities[id] = resource.capacityBytes;
      incarnations[id] = resource.incarnation;
    });
    this.#validateMeshCapabilities(capacities);

    const current = this.#currentMeshArena;
    const backingMatches =
      current !== undefined &&
      MESH_RESOURCE_IDS.every(
        (id) =>
          current.incarnations[id] === incarnations[id] &&
          current.capacities[id] === capacities[id],
      );
    let instances: ReadonlySet<number> = backingMatches ? current.instances : new Set<number>();
    let links: ReadonlyMap<number, number> = backingMatches
      ? current.links
      : new Map<number, number>();
    let frameInitialized = backingMatches ? current.frameInitialized : false;
    const writeRecords = new Map<MeshResourceId, MeshRecordRange[]>(
      MESH_RESOURCE_IDS.map((id) => [id, []]),
    );
    let previousResource = -1;
    let previousEnd = 0;
    for (const write of part.writes) {
      const resourceIndex = MESH_RESOURCE_IDS.indexOf(write.resourceId);
      if (
        resourceIndex < 0 ||
        write.incarnation !== incarnations[write.resourceId] ||
        !Number.isSafeInteger(write.byteOffset) ||
        write.byteOffset < 0 ||
        write.byteOffset % 4 !== 0 ||
        !(write.bytes instanceof Uint8Array) ||
        write.bytes.byteLength === 0 ||
        write.bytes.byteLength % 4 !== 0 ||
        write.byteOffset + write.bytes.byteLength > capacities[write.resourceId] ||
        resourceIndex < previousResource ||
        (resourceIndex === previousResource && write.byteOffset < previousEnd)
      ) {
        throw new TypeError('Invalid mesh write range.');
      }
      previousResource = resourceIndex;
      previousEnd = write.byteOffset + write.bytes.byteLength;
      const stride = MESH_RESOURCE_STRIDES[write.resourceId];
      const firstIndex = write.byteOffset / stride;
      if (
        !Number.isInteger(firstIndex) ||
        write.bytes.byteLength % stride !== 0 ||
        !isArrayValue(write.records)
      ) {
        throw new TypeError('Mesh write records do not cover the write range.');
      }
      // E26 contract, U5a: the ranges cover the write's records in order, without gaps or overlap.
      const end = firstIndex + write.bytes.byteLength / stride;
      let next = firstIndex;
      for (const range of write.records) {
        if (
          range.index !== next ||
          !Number.isSafeInteger(range.count) ||
          range.count <= 0 ||
          range.index + range.count > end ||
          typeof range.version !== 'symbol'
        ) {
          throw new TypeError('Invalid mesh record range.');
        }
        next += range.count;
        writeRecords.get(write.resourceId)!.push(Object.freeze({ ...range }));
      }
      if (next !== end) throw new TypeError('Mesh write records do not cover the write range.');
      if (write.resourceId === 'meshInstances') {
        const nextInstances = new Set(instances);
        for (let index = firstIndex; index < end; index += 1) nextInstances.add(index);
        instances = nextInstances;
        // Word 15 of each written record, for the joint draw check below (ST-U7, section 4.5).
        const view = new DataView(
          write.bytes.buffer,
          write.bytes.byteOffset,
          write.bytes.byteLength,
        );
        const nextLinks = new Map(links);
        for (let index = firstIndex; index < end; index += 1) {
          nextLinks.set(index, view.getUint32((index - firstIndex) * stride + 60, true));
        }
        links = nextLinks;
      } else if (write.resourceId === 'meshFrame') {
        frameInitialized = true;
      }
    }

    const instanceCapacity = capacities.meshInstances / MESH_RESOURCE_STRIDES.meshInstances;
    const triangleCapacity = capacities.meshTriangles / MESH_RESOURCE_STRIDES.meshTriangles;
    // E25 U3: a layer's mesh draws are checked like the main pass's, against the layer's runs.
    for (const { draws, analyticDraws: runs } of [
      { draws: part.draws, analyticDraws },
      ...layerDraws,
    ]) {
      let previousPosition = 0;
      for (const [drawIndex, draw] of draws.entries()) {
        if (
          typeof draw !== 'object' ||
          draw === null ||
          !Number.isSafeInteger(draw.position) ||
          draw.position < previousPosition ||
          draw.position > runs ||
          !Number.isSafeInteger(draw.instance) ||
          draw.instance < 0 ||
          draw.instance >= instanceCapacity ||
          !instances.has(draw.instance) ||
          !Number.isSafeInteger(draw.firstTriangle) ||
          draw.firstTriangle < 0 ||
          !Number.isSafeInteger(draw.triangleCount) ||
          draw.triangleCount <= 0 ||
          draw.firstTriangle + draw.triangleCount > triangleCapacity ||
          (draw.composite !== undefined && draw.composite !== 'joint-fill') ||
          !validMeshCoverage(draw) ||
          (draw.coverage !== undefined &&
            draw.composite !== undefined &&
            draw.coverage !== 'winding')
        ) {
          throw new TypeError('Invalid mesh draw.');
        }
        if (draw.composite === 'joint-fill') {
          // ST-U7 addendum, section 4.5: word 15 - 1 of a joint fill record names the stroke
          // record, which must be a written instance below capacity, as draw.instance is.
          const stroke = (links.get(draw.instance) ?? 0) - 1;
          if (stroke < 0 || stroke >= instanceCapacity || !instances.has(stroke)) {
            throw new TypeError('Invalid joint mesh draw.');
          }
          // E39-R6: a joint draw over a winding mesh is followed by its stroke's union draw at
          // the same position and clip state, which the passes draw with it.
          const next = draws[drawIndex + 1];
          if (
            draw.coverage !== undefined &&
            (next === undefined ||
              next.coverage !== 'union' ||
              next.composite !== undefined ||
              next.instance !== stroke ||
              next.position !== draw.position ||
              (next.clipState ?? 0) !== (draw.clipState ?? 0))
          ) {
            throw new TypeError('Invalid joint mesh draw.');
          }
        }
        previousPosition = draw.position;
      }
    }
    // P4 contract, U4: a mask level's mesh source draw is checked like a plain mesh draw.
    for (const draw of maskDraws) {
      if (
        !Number.isSafeInteger(draw.instance) ||
        draw.instance < 0 ||
        draw.instance >= instanceCapacity ||
        !instances.has(draw.instance) ||
        !Number.isSafeInteger(draw.firstTriangle) ||
        draw.firstTriangle < 0 ||
        !Number.isSafeInteger(draw.triangleCount) ||
        draw.triangleCount <= 0 ||
        draw.firstTriangle + draw.triangleCount > triangleCapacity ||
        !validMeshCoverage(draw) ||
        draw.coverage === 'union'
      ) {
        throw new TypeError('Invalid mask source draw.');
      }
    }
    const layerDrawCount = layerDraws.reduce((sum, layer) => sum + layer.draws.length, 0);
    if (part.draws.length + maskDraws.length + layerDrawCount > 0 && !frameInitialized) {
      throw new TypeError('Mesh frame data is uninitialized.');
    }

    let arena = current;
    let createdArena = false;
    if (!backingMatches) {
      arena = this.#createMeshArena(capacities, incarnations);
      createdArena = true;
    }
    return Object.freeze({
      skipped: false as const,
      arena: arena!,
      createdArena,
      instances,
      links,
      frameInitialized,
      draws: part.draws,
      receiptResources: Object.freeze(
        MESH_RESOURCE_IDS.map((resourceId) =>
          Object.freeze({
            resourceId,
            incarnation: incarnations[resourceId],
            records: Object.freeze(writeRecords.get(resourceId) ?? []),
          }),
        ),
      ),
    });
  }

  #validateMeshCapabilities(capacities: Readonly<Record<MeshResourceId, number>>): void {
    const limits = this.#device.limits;
    const storageLimit = safeLimit(limits.maxStorageBufferBindingSize, 0);
    if (
      MESH_RESOURCE_IDS.slice(0, 5).some((id) => capacities[id] > storageLimit) ||
      capacities.meshFrame > safeLimit(limits.maxUniformBufferBindingSize, 0) ||
      this.#layoutCapacity(MESH_RESOURCE_IDS.map((id) => capacities[id])) >
        safeLimit(limits.maxBufferSize, 0)
    ) {
      throw new AllocationError();
    }
  }

  #createMeshArena(
    capacities: Readonly<Record<MeshResourceId, number>>,
    incarnations: Readonly<Record<MeshResourceId, symbol>>,
  ): MeshArenaState {
    const alignment = this.#requiredAlignment();
    const capacity = this.#layoutCapacity(MESH_RESOURCE_IDS.map((id) => capacities[id]));
    const allocator = new SharedBufferAllocator({
      capacityBytes: capacity,
      alignment,
      generation: this.#generation,
    });
    const allocations = {} as Record<MeshResourceId, SharedBufferAllocation>;
    for (const id of MESH_RESOURCE_IDS) {
      const allocation = allocator.allocate(capacities[id]);
      if (allocation === undefined) {
        allocator.dispose();
        throw new AllocationError();
      }
      allocations[id] = allocation;
    }
    const arenaNumber = this.#nextArenaId;
    this.#nextArenaId += 1;
    const id = `primitive/${this.#generation}/mesh-arena-${arenaNumber}`;
    const bindGroupId = `${id}/bind-group`;
    let buffer: GPUBuffer | undefined;
    let bufferTracked = false;
    let bindGroupTracked = false;
    try {
      buffer = this.#device.createBuffer({
        label: id,
        size: capacity,
        usage: STORAGE_BUFFER_USAGE | UNIFORM_BUFFER_USAGE | COPY_DESTINATION_USAGE,
      });
      this.#resources.track(id, { category: 'buffer', size: capacity });
      bufferTracked = true;
      const bindGroup = this.#device.createBindGroup({
        label: bindGroupId,
        layout: this.#mesh!.bindGroupLayout,
        entries: MESH_RESOURCE_IDS.map((resourceId) => ({
          binding: MESH_PACKET_BINDINGS[resourceId],
          resource: {
            buffer: buffer as GPUBuffer,
            offset: allocations[resourceId].offset,
            size: capacities[resourceId],
          },
        })),
      });
      this.#resources.track(bindGroupId, { category: 'bind-group' });
      bindGroupTracked = true;
      return {
        id,
        bindGroupId,
        buffer,
        bindGroup,
        allocator,
        allocations: Object.freeze(allocations),
        allocationList: Object.freeze(
          MESH_RESOURCE_IDS.map((resourceId) => allocations[resourceId]),
        ),
        incarnations: Object.freeze({ ...incarnations }),
        capacities: Object.freeze({ ...capacities }),
        instances: new Set<number>(),
        links: new Map<number, number>(),
        frameInitialized: false,
        lastSubmittedSerial: 0,
        retired: false,
        released: false,
      };
    } catch (error) {
      if (bindGroupTracked) this.#resources.release(bindGroupId);
      if (bufferTracked) this.#resources.release(id);
      buffer?.destroy();
      allocator.dispose();
      throw new AllocationError(error);
    }
  }

  #commitMesh(mesh: Extract<ValidatedMesh, { skipped: false }>): void {
    const arena = mesh.arena;
    if (arena === null) return;
    arena.instances = mesh.instances;
    arena.links = mesh.links;
    arena.frameInitialized = mesh.frameInitialized;
    if (mesh.createdArena) {
      const previous = this.#currentMeshArena;
      this.#currentMeshArena = arena;
      if (previous !== undefined) this.#retireArena(previous);
    }
  }

  #validateCapabilities(capacities: Readonly<Record<PrimitiveResourceId, number>>): void {
    const limits = this.#device.limits;
    const storageLimit = safeLimit(limits.maxStorageBufferBindingSize, 0);
    const uniformLimit = safeLimit(limits.maxUniformBufferBindingSize, 0);
    const bufferLimit = safeLimit(limits.maxBufferSize, 0);
    if (
      safeLimit(limits.maxStorageBuffersPerShaderStage, 0) < 4 ||
      safeLimit(limits.maxUniformBuffersPerShaderStage, 0) < 1 ||
      safeLimit(limits.maxBindingsPerBindGroup, 0) < 5 ||
      safeLimit(limits.maxBindGroups, 0) < 1 ||
      RESOURCE_ORDER.slice(0, 4).some((id) => capacities[id] > storageLimit) ||
      capacities.frame > uniformLimit ||
      this.#arenaCapacity(capacities) > bufferLimit
    ) {
      throw new AllocationError();
    }
  }

  #arenaCapacity(capacities: Readonly<Record<PrimitiveResourceId, number>>): number {
    return this.#layoutCapacity(RESOURCE_ORDER.map((id) => capacities[id]));
  }

  /** Aligned regions in resource order inside one power-of-two buffer. */
  #layoutCapacity(sizes: readonly number[]): number {
    const alignment = this.#requiredAlignment();
    let end = 0;
    for (const size of sizes) {
      end = align(end, alignment) + align(size, alignment);
    }
    const capacity = nextPowerOfTwo(end);
    if (!Number.isSafeInteger(capacity)) throw new AllocationError();
    return capacity;
  }

  #createArena(
    capacities: Readonly<Record<PrimitiveResourceId, number>>,
    incarnations: Readonly<Record<PrimitiveResourceId, symbol>>,
  ): ArenaState {
    const alignment = this.#requiredAlignment();
    const capacity = this.#arenaCapacity(capacities);
    const allocator = new SharedBufferAllocator({
      capacityBytes: capacity,
      alignment,
      generation: this.#generation,
    });
    const allocations = {} as Record<PrimitiveResourceId, SharedBufferAllocation>;
    for (const id of RESOURCE_ORDER) {
      const allocation = allocator.allocate(capacities[id]);
      if (allocation === undefined) {
        allocator.dispose();
        throw new AllocationError();
      }
      allocations[id] = allocation;
    }
    const arenaNumber = this.#nextArenaId;
    this.#nextArenaId += 1;
    const id = `primitive/${this.#generation}/arena-${arenaNumber}`;
    const bindGroupId = `${id}/bind-group`;
    let buffer: GPUBuffer | undefined;
    let bufferTracked = false;
    let bindGroupTracked = false;
    try {
      buffer = this.#device.createBuffer({
        label: id,
        size: capacity,
        usage: STORAGE_BUFFER_USAGE | UNIFORM_BUFFER_USAGE | COPY_DESTINATION_USAGE,
      });
      this.#resources.track(id, { category: 'buffer', size: capacity });
      bufferTracked = true;
      const bindGroup = this.#device.createBindGroup({
        label: bindGroupId,
        layout: this.#bindGroupLayout,
        entries: RESOURCE_ORDER.map((resourceId) => ({
          binding: PRIMITIVE_PACKET_BINDINGS[resourceId],
          resource: {
            buffer: buffer as GPUBuffer,
            offset: allocations[resourceId].offset,
            size: capacities[resourceId],
          },
        })),
      });
      this.#resources.track(bindGroupId, { category: 'bind-group' });
      bindGroupTracked = true;
      return {
        id,
        bindGroupId,
        buffer,
        bindGroup,
        allocator,
        allocations: Object.freeze(allocations),
        allocationList: Object.freeze(RESOURCE_ORDER.map((resourceId) => allocations[resourceId])),
        incarnations: Object.freeze({ ...incarnations }),
        capacities: Object.freeze({ ...capacities }),
        initialized: Object.freeze({
          transforms: new Set<number>(),
          geometry: new Set<number>(),
          styles: new Set<number>(),
        }),
        order: new Map(),
        frameInitialized: false,
        sceneEpoch: null,
        lastSubmittedSerial: 0,
        retired: false,
        released: false,
      };
    } catch (error) {
      if (bindGroupTracked) this.#resources.release(bindGroupId);
      if (bufferTracked) this.#resources.release(id);
      buffer?.destroy();
      allocator.dispose();
      throw new AllocationError(error);
    }
  }

  #commitPacket(packet: PrimitivePacket, validated: ValidatedPacket): void {
    const arena = validated.arena;
    arena.initialized = validated.initialized;
    arena.order = validated.order;
    arena.frameInitialized = validated.frameInitialized;
    arena.sceneEpoch = packet.sceneEpoch;
    if (validated.createdArena) {
      const previous = this.#currentArena;
      this.#currentArena = arena;
      if (previous !== undefined) this.#retireArena(previous);
    }
  }

  #requiredAlignment(): number {
    const storage = this.#device.limits.minStorageBufferOffsetAlignment;
    const uniform = this.#device.limits.minUniformBufferOffsetAlignment;
    if (
      typeof storage !== 'number' ||
      typeof uniform !== 'number' ||
      !isPowerOfTwo(storage) ||
      !isPowerOfTwo(uniform)
    ) {
      throw new AllocationError();
    }
    return Math.max(4, storage, uniform);
  }

  #retireArena(arena: ArenaBase): void {
    if (arena.released || arena.retired) return;
    arena.retired = true;
    for (const allocation of arena.allocationList) arena.allocator.free(allocation);
    if (arena.allocator.snapshot().reservedBytes === 0) this.#releaseArena(arena);
    else this.#retiredArenas.push(arena);
  }

  #observeCompletion(): void {
    if (this.#disposed || this.#completionObserverPending) return;
    const observedSerial = this.#latestSubmittedSerial;
    this.#completionObserverPending = true;
    let completion: Promise<void>;
    try {
      completion = this.#device.queue.onSubmittedWorkDone();
    } catch {
      this.#completionObserverPending = false;
      return;
    }
    void completion.then(
      () => {
        this.#completionObserverPending = false;
        if (this.#disposed) return;
        const arenas = [this.#currentArena, this.#currentMeshArena, ...this.#retiredArenas].filter(
          (arena): arena is ArenaBase => arena !== undefined,
        );
        for (const arena of arenas) {
          const completed = Math.min(observedSerial, arena.lastSubmittedSerial);
          if (completed > 0) arena.allocator.completeThrough(this.#generation, completed);
        }
        const retained: ArenaBase[] = [];
        for (const arena of this.#retiredArenas) {
          if (arena.allocator.snapshot().reservedBytes === 0) this.#releaseArena(arena);
          else retained.push(arena);
        }
        this.#retiredArenas = retained;
        if (this.#latestSubmittedSerial > observedSerial) this.#observeCompletion();
      },
      () => {
        this.#completionObserverPending = false;
      },
    );
  }

  #releaseArena(arena: ArenaBase): void {
    if (arena.released) return;
    arena.released = true;
    let firstError: unknown;
    for (const action of [
      () => arena.buffer.destroy(),
      () => arena.allocator.dispose(),
      () => this.#resources.release(arena.bindGroupId),
      () => this.#resources.release(arena.id),
    ]) {
      try {
        action();
      } catch (error) {
        firstError ??= error;
      }
    }
    if (firstError !== undefined) throw asError(firstError, 'Primitive arena release failed.');
  }

  /** Releases the color and stencil attachments; both are rebuilt by the next setTarget. */
  #releaseAttachment(): void {
    let firstError: unknown;
    for (const release of [() => this.#releaseColorAttachment(), () => this.#releaseStencil()]) {
      try {
        release();
      } catch (error) {
        firstError ??= error;
      }
    }
    if (firstError !== undefined) throw asError(firstError, 'Primitive attachment release failed.');
  }

  /** E17 contract, section 3: creates and tracks the target's stencil attachment. */
  #createStencilAttachment(target: PrimitiveTarget): Readonly<{ texture: GPUTexture; id: string }> {
    const id = `primitive/${this.#generation}/stencil-${target.surfaceRevision}`;
    const stencil = this.#device.createTexture({
      label: id,
      size: { width: target.width, height: target.height },
      sampleCount: this.sampleCount,
      format: MESH_STENCIL_FORMAT,
      usage: RENDER_ATTACHMENT_USAGE,
    });
    try {
      this.#resources.track(id, {
        category: 'texture',
        dimension: '2d',
        width: target.width,
        height: target.height,
        depthOrArrayLayers: 1,
        mipLevelCount: 1,
        sampleCount: this.sampleCount,
        // The WebGPU texel size of stencil8; a backend may store it in a wider texel (E17-R1).
        bytesPerTexel: 1,
      });
    } catch (error) {
      stencil.destroy();
      throw asError(error, 'Primitive stencil attachment accounting failed.');
    }
    return { texture: stencil, id };
  }

  /** Replaces the current stencil attachment with a created one. */
  #commitStencilAttachment(stencil: Readonly<{ texture: GPUTexture; id: string }>): void {
    this.#releaseStencil();
    this.#stencilAttachment = stencil.texture;
    this.#stencilAttachmentId = stencil.id;
  }

  /** Destroys and releases a created stencil attachment that was never committed. */
  #discardStencilAttachment(stencil: Readonly<{ texture: GPUTexture; id: string }>): void {
    try {
      stencil.texture.destroy();
    } finally {
      this.#resources.release(stencil.id);
    }
  }

  #releaseStencil(): void {
    const stencil = this.#stencilAttachment;
    const stencilId = this.#stencilAttachmentId;
    this.#stencilAttachment = undefined;
    this.#stencilAttachmentId = undefined;
    let destroyError: unknown;
    try {
      stencil?.destroy();
    } catch (error) {
      destroyError = error;
    }
    if (stencilId !== undefined) this.#resources.release(stencilId);
    if (destroyError !== undefined)
      throw asError(destroyError, 'Primitive stencil attachment release failed.');
  }

  #releaseColorAttachment(): void {
    const attachment = this.#attachment;
    const attachmentId = this.#attachmentId;
    this.#attachment = undefined;
    this.#attachmentId = undefined;
    let destroyError: unknown;
    try {
      attachment?.destroy();
    } catch (error) {
      destroyError = error;
    }
    if (attachmentId !== undefined) this.#resources.release(attachmentId);
    if (destroyError !== undefined)
      throw asError(destroyError, 'Primitive attachment release failed.');
  }

  #requireActive(): void {
    if (this.#disposed) throw new Error('Primitive scene is disposed.');
  }
}

class AllocationError extends Error {
  public constructor(cause?: unknown) {
    super('Primitive arena allocation failed.', cause === undefined ? undefined : { cause });
  }
}

/**
 * E30-U5 (L3b): whether a clip state record and everything `packClipState` reads from it are
 * frozen, so a record seen again as the same object has the same contents. It assumes plain data
 * properties, as the source's records have: a frozen getter or a proxy is not detected.
 */
function deeplyFrozenClipRecord(record: ClipPacketPart['states'][number]): boolean {
  if (
    !Object.isFrozen(record) ||
    !Object.isFrozen(record.rects) ||
    !Object.isFrozen(record.masks)
  ) {
    return false;
  }
  for (const rect of record.rects) {
    if (!Object.isFrozen(rect) || !Object.isFrozen(rect.toLocal)) return false;
  }
  return true;
}

/**
 * Byte equality for the change-only writes. E30-U5 (L3): compared in 32-bit words where both views
 * are aligned (the callback form cost about 20 ms of an unchanged frame's 1,300 clip states in
 * the container). Exported for its unit test only.
 * @internal
 */
export function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left === right) return true;
  const length = left.byteLength;
  if (length !== right.byteLength) return false;
  let index = 0;
  if (left.byteOffset % 4 === 0 && right.byteOffset % 4 === 0) {
    const words = length >>> 2;
    const leftWords = new Uint32Array(left.buffer, left.byteOffset, words);
    const rightWords = new Uint32Array(right.buffer, right.byteOffset, words);
    for (let word = 0; word < words; word += 1) {
      if (leftWords[word] !== rightWords[word]) return false;
    }
    index = words << 2;
  }
  for (; index < length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function sameSet(...sets: readonly ReadonlySet<number>[]): boolean {
  const first = sets[0];
  if (first === undefined) return true;
  return sets
    .slice(1)
    .every(
      (candidate) =>
        candidate.size === first.size && [...first].every((value) => candidate.has(value)),
    );
}

/** The receipt's mesh part: skipped when the mesh path is unavailable for this generation. */
function meshReceipt(part: MeshPacketPart, mesh: ValidatedMesh): MeshReceiptPart {
  if (mesh.skipped) return Object.freeze({ status: 'skipped' as const });
  return Object.freeze({
    status: 'submitted' as const,
    originRevision: part.originRevision,
    resources: mesh.receiptResources,
  });
}

function createReceipt(
  packet: PrimitivePacket,
  submissionSerial: number,
  resources: PrimitiveReceipt['resources'],
  mesh?: MeshReceiptPart,
  text?: TextReceiptPart,
): PrimitiveReceipt {
  return Object.freeze({
    scene: Object.freeze({
      identity: Object.freeze({ ...packet.scene.identity }),
      revision: packet.scene.revision,
    }),
    sceneEpoch: packet.sceneEpoch,
    cameraRevision: packet.cameraRevision,
    surfaceRevision: packet.surfaceRevision,
    originRevision: packet.originRevision,
    generation: packet.generation,
    packetId: packet.packetId,
    submissionSerial,
    resources,
    ...(mesh === undefined ? {} : { mesh }),
    ...(text === undefined ? {} : { text }),
  });
}

export function createNativePrimitiveSceneCreation(
  device: GPUDevice,
  context: WebGpuCanvasContextPort,
  format: PrimitiveTargetFormat,
  generation: number,
  resources: WebGpuResourceTracker,
  options: WebGpuPrimitiveSceneOptions = {},
): WebGpuPrimitiveSceneCreationPort {
  let disposed = false;
  let scene: NativePrimitiveScene | undefined;
  let pipelineCache: PipelineCache<GPURenderPipeline> | undefined;
  let vertexBuffer: GPUBuffer | undefined;
  let indexBuffer: GPUBuffer | undefined;
  const tracked = new Set<string>();
  const prefix = `primitive/${generation}`;
  const track = (id: string, descriptor: ResourceDescriptor) => {
    resources.track(id, descriptor);
    tracked.add(id);
  };
  const releasePending = () => {
    try {
      vertexBuffer?.destroy();
    } catch {
      // Continue releasing the rest of the partial creation.
    }
    vertexBuffer = undefined;
    try {
      indexBuffer?.destroy();
    } catch {
      // Continue releasing the rest of the partial creation.
    }
    indexBuffer = undefined;
    try {
      pipelineCache?.dispose();
    } catch {
      // Continue releasing accounting entries.
    }
    pipelineCache = undefined;
    for (const id of tracked) {
      try {
        resources.release(id);
      } catch {
        // Accounting cleanup is best effort during failed creation.
      }
    }
    tracked.clear();
  };
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    if (scene !== undefined) {
      scene.dispose();
      scene = undefined;
    } else {
      releasePending();
    }
  };

  const result = (async (): Promise<WebGpuPrimitiveSceneResult> => {
    if (!isNativeCanvasContext(context)) {
      throw new TypeError('Browser primitive scene requires a browser canvas context.');
    }
    if (!isPositiveSafeInteger(generation)) {
      throw new RangeError('generation must be a positive safe integer.');
    }
    const tileSize = options.layerTileSizeForTesting;
    if (tileSize !== undefined && !(isPositiveSafeInteger(tileSize) && tileSize % 2 === 0)) {
      throw new RangeError('layerTileSizeForTesting must be a positive even integer.');
    }
    const bindGroupLayout = device.createBindGroupLayout(
      createPrimitiveBindGroupLayoutDescriptor(),
    );
    const pipelineLayout = device.createPipelineLayout({
      label: `${prefix}/pipeline-layout`,
      bindGroupLayouts: [bindGroupLayout],
    });
    const shader = device.createShaderModule({
      label: `${prefix}/shader`,
      code: PRIMITIVE_ANALYTIC_SHADER,
    });
    track(`${prefix}/bind-group-layout`, { category: 'bind-group-layout' });
    track(`${prefix}/pipeline-layout`, { category: 'pipeline-layout' });
    track(`${prefix}/shader`, { category: 'shader-module' });

    const quad = createPrimitiveUnitQuadData();
    vertexBuffer = device.createBuffer({
      label: `${prefix}/quad-vertices`,
      size: quad.vertices.byteLength,
      usage: VERTEX_BUFFER_USAGE | COPY_DESTINATION_USAGE,
    });
    track(`${prefix}/quad-vertices`, { category: 'buffer', size: quad.vertices.byteLength });
    device.queue.writeBuffer(vertexBuffer, 0, quad.vertices, 0, quad.vertices.length);
    indexBuffer = device.createBuffer({
      label: `${prefix}/quad-indices`,
      size: quad.indices.byteLength,
      usage: INDEX_BUFFER_USAGE | COPY_DESTINATION_USAGE,
    });
    track(`${prefix}/quad-indices`, { category: 'buffer', size: quad.indices.byteLength });
    device.queue.writeBuffer(indexBuffer, 0, quad.indices, 0, quad.indices.length);

    pipelineCache = new PipelineCache<GPURenderPipeline>(generation);
    // E17 contract, section 3: a generation created with the mesh pipeline option draws in a
    // pass with the write-once stencil attachment, so its analytic pipeline declares it too.
    const stencil = options.meshPipeline === true;
    const createPipeline = (sampleCount: 1 | 4) =>
      pipelineCache!.getOrCreate(primitivePipelineKey(format, sampleCount, stencil), () =>
        device.createRenderPipelineAsync(
          createPrimitivePipelineDescriptor(shader, pipelineLayout, format, sampleCount, stencil),
        ),
      );
    let pipeline: GPURenderPipeline;
    // E10 contract, section 3.2: a forced sample count never falls back.
    const forced = options.sampleCount;
    let sampleCount: 1 | 4 = forced ?? 4;
    let fellBackFrom4x = false;
    if (forced === 1) {
      pipeline = await createPipeline(1);
    } else {
      try {
        pipeline = await createPipeline(4);
      } catch (error) {
        if (disposed) throw asError(error, '4x pipeline creation failed after disposal.');
        if (forced === 4) {
          throw new TestHookCreationError('The forced 4x pipeline is unavailable.', {
            forcedSampleCount: 4,
          });
        }
        sampleCount = 1;
        fellBackFrom4x = true;
        pipeline = await createPipeline(1);
      }
    }
    if (disposed) throw new Error('Primitive scene creation completed after disposal.');
    track(`${prefix}/pipeline`, { category: 'render-pipeline' });
    // P3 V3 section f: the mesh pipeline is created here, at initialization and at each
    // recovery, next to the P1 pipeline, and never on the frame path.
    let mesh: MeshPipelineState | null = null;
    let meshShaderModulesCreated = 0;
    let count: CountPipelineState | null = null;
    // A forced 4x mesh pipeline that fails reports the forced sample count (section 3.2).
    let meshFailure: unknown;
    // Whether the mesh pipelines were built and only the count pipelines failed.
    let countFailed = false;
    if (options.meshPipeline === true) {
      const meshTracked: string[] = [];
      const trackMesh = (id: string, descriptor: ResourceDescriptor) => {
        track(id, descriptor);
        meshTracked.push(id);
      };
      const limits = device.limits;
      if (
        safeLimit(limits.maxStorageBuffersPerShaderStage, 0) >=
          MESH_REQUIRED_STORAGE_BUFFERS_PER_STAGE &&
        safeLimit(limits.maxBindingsPerBindGroup, 0) >= MESH_REQUIRED_BINDINGS_PER_BIND_GROUP
      ) {
        try {
          const meshBindGroupLayout = device.createBindGroupLayout(
            createMeshBindGroupLayoutDescriptor(),
          );
          trackMesh(`${prefix}/mesh-bind-group-layout`, { category: 'bind-group-layout' });
          const meshPipelineLayout = device.createPipelineLayout({
            label: `${prefix}/mesh-pipeline-layout`,
            bindGroupLayouts: [meshBindGroupLayout],
          });
          trackMesh(`${prefix}/mesh-pipeline-layout`, { category: 'pipeline-layout' });
          const meshShader = device.createShaderModule({
            label: `${prefix}/mesh-shader`,
            code: MESH_FILL_SHADER,
          });
          meshShaderModulesCreated = 1;
          trackMesh(`${prefix}/mesh-shader`, { category: 'shader-module' });
          const meshPipeline = await pipelineCache.getOrCreate(
            meshPipelineKey(format, sampleCount),
            () =>
              device.createRenderPipelineAsync(
                createMeshPipelineDescriptor(meshShader, meshPipelineLayout, format, sampleCount),
              ),
          );
          trackMesh(`${prefix}/mesh-pipeline`, { category: 'render-pipeline' });
          // ST-U7 addendum, section 4.5: the joint pipeline, same module and layout. If either
          // pipeline fails, the mesh path is unavailable for this generation: a joint path
          // cannot fall back to two plain draws without opacity applied twice.
          const jointPipeline = await pipelineCache.getOrCreate(
            meshPipelineKey(format, sampleCount, 'joint'),
            () =>
              device.createRenderPipelineAsync(
                createMeshPipelineDescriptor(
                  meshShader,
                  meshPipelineLayout,
                  format,
                  sampleCount,
                  'joint',
                ),
              ),
          );
          trackMesh(`${prefix}/mesh-joint-pipeline`, { category: 'render-pipeline' });
          // E17 contract, section 3: the stencil reset draw, from its own small module.
          const resetShader = device.createShaderModule({
            label: `${prefix}/mesh-stencil-reset-shader`,
            code: MESH_STENCIL_RESET_SHADER,
          });
          meshShaderModulesCreated = 2;
          trackMesh(`${prefix}/mesh-stencil-reset-shader`, { category: 'shader-module' });
          const resetPipeline = await device.createRenderPipelineAsync(
            createMeshStencilResetPipelineDescriptor(
              resetShader,
              format,
              sampleCount,
              `vector-studio/p3-mesh-stencil-reset-${sampleCount}x`,
            ),
          );
          trackMesh(`${prefix}/mesh-stencil-reset-pipeline`, { category: 'render-pipeline' });
          // E39-R8: the stencil pass pipelines at the main format and the plain covers.
          const stencilPipelines = await createMeshStencilPipelines(
            pipelineCache,
            device,
            meshShader,
            meshPipelineLayout,
            format,
            sampleCount,
          );
          for (const kind of MESH_STENCIL_KINDS) {
            trackMesh(`${prefix}/mesh-stencil-${kind}-pipeline`, { category: 'render-pipeline' });
          }
          const coverPipelines = await createMeshCoverPipelines((kind) =>
            pipelineCache!.getOrCreate(meshPipelineKey(format, sampleCount, kind), () =>
              device.createRenderPipelineAsync(
                createMeshPipelineDescriptor(
                  meshShader,
                  meshPipelineLayout,
                  format,
                  sampleCount,
                  kind,
                ),
              ),
            ),
          );
          for (const rule of MESH_COVER_NAMES) {
            trackMesh(`${prefix}/mesh-cover-${rule}-pipeline`, { category: 'render-pipeline' });
          }
          mesh = Object.freeze({
            pipeline: meshPipeline,
            jointPipeline,
            resetPipeline,
            resetShader,
            bindGroupLayout: meshBindGroupLayout,
            stencil: stencilPipelines,
            cover: coverPipelines,
          });
          if (options.countPass === true) {
            count = await createCountPipelines(
              device,
              meshPipelineLayout,
              resetShader,
              sampleCount,
              prefix,
              trackMesh,
            );
          }
        } catch (error) {
          meshFailure = error;
          countFailed = mesh !== null;
          // The mesh path is unavailable for this generation; primitives still draw.
          for (const id of meshTracked) {
            tracked.delete(id);
            try {
              resources.release(id);
            } catch {
              // Accounting cleanup is best effort.
            }
          }
          mesh = null;
          count = null;
        }
      }
      if (meshFailure !== undefined && forced === 4) {
        throw new TestHookCreationError('The forced 4x mesh pipeline is unavailable.', {
          forcedSampleCount: 4,
        });
      }
      if (countFailed) {
        throw new TestHookCreationError('The count pipelines are unavailable.', {
          countPipeline: 'unavailable',
        });
      }
    }
    // P4 contract, U3: the clip variants, created here like the mesh path and never on the
    // frame path. A failure leaves them unavailable: unclipped draws are unaffected, and a
    // clipped draw is not drawn.
    let clip: ClipPipelineState | null = null;
    let defaultMask: GPUTexture | undefined;
    if (options.clipPipeline === true && !disposed) {
      const clipTracked: string[] = [];
      const trackClip = (id: string, descriptor: ResourceDescriptor) => {
        track(id, descriptor);
        clipTracked.push(id);
      };
      try {
        const clipBindGroupLayout = device.createBindGroupLayout(
          createClipBindGroupLayoutDescriptor(),
        );
        trackClip(`${prefix}/clip-bind-group-layout`, { category: 'bind-group-layout' });
        const clipPipelineLayout = device.createPipelineLayout({
          label: `${prefix}/clip-pipeline-layout`,
          bindGroupLayouts: [bindGroupLayout, clipBindGroupLayout],
        });
        trackClip(`${prefix}/clip-pipeline-layout`, { category: 'pipeline-layout' });
        const clipShader = device.createShaderModule({
          label: `${prefix}/clip-shader`,
          code: PRIMITIVE_ANALYTIC_CLIP_SHADER,
        });
        trackClip(`${prefix}/clip-shader`, { category: 'shader-module' });
        const analytic = await pipelineCache.getOrCreate(
          clipVariantKey(primitivePipelineKey(format, sampleCount, stencil)),
          () =>
            device.createRenderPipelineAsync(
              clipDescriptor(
                createPrimitivePipelineDescriptor(
                  clipShader,
                  clipPipelineLayout,
                  format,
                  sampleCount,
                  stencil,
                ),
              ),
            ),
        );
        trackClip(`${prefix}/clip-pipeline`, { category: 'render-pipeline' });
        // U4: the mask passes' pipelines and the default mask texture.
        const maskShader = device.createShaderModule({
          label: `${prefix}/mask-shader`,
          code: PRIMITIVE_ANALYTIC_MASK_SHADER,
        });
        trackClip(`${prefix}/mask-shader`, { category: 'shader-module' });
        const maskAnalytic = await device.createRenderPipelineAsync(
          maskDescriptor(
            createPrimitivePipelineDescriptor(maskShader, clipPipelineLayout, format, sampleCount),
          ),
        );
        trackClip(`${prefix}/mask-pipeline`, { category: 'render-pipeline' });
        defaultMask = device.createTexture({
          label: `${prefix}/clip-default-mask`,
          size: { width: 1, height: 1 },
          format: CLIP_MASK_FORMAT,
          usage: TEXTURE_BINDING_USAGE,
        });
        trackClip(`${prefix}/clip-default-mask`, {
          category: 'texture',
          dimension: '2d',
          width: 1,
          height: 1,
          depthOrArrayLayers: 1,
          mipLevelCount: 1,
          sampleCount: 1,
          bytesPerTexel: 1,
        });
        let meshClip: GPURenderPipeline | null = null;
        let meshJointClip: GPURenderPipeline | null = null;
        let meshCoverClip: MeshCoverPipelines | null = null;
        let maskMesh: GPURenderPipeline | null = null;
        let maskStencil: GPURenderPipeline | null = null;
        let maskCover: MeshMaskCoverPipelines | null = null;
        if (mesh !== null) {
          const meshClipLayout = device.createPipelineLayout({
            label: `${prefix}/mesh-clip-pipeline-layout`,
            bindGroupLayouts: [mesh.bindGroupLayout, clipBindGroupLayout],
          });
          trackClip(`${prefix}/mesh-clip-pipeline-layout`, { category: 'pipeline-layout' });
          const meshClipShader = device.createShaderModule({
            label: `${prefix}/mesh-clip-shader`,
            code: MESH_FILL_CLIP_SHADER,
          });
          trackClip(`${prefix}/mesh-clip-shader`, { category: 'shader-module' });
          const meshVariant = (kind: MeshPipelineKind) =>
            pipelineCache!.getOrCreate(
              clipVariantKey(meshPipelineKey(format, sampleCount, kind)),
              () =>
                device.createRenderPipelineAsync(
                  clipDescriptor(
                    createMeshPipelineDescriptor(
                      meshClipShader,
                      meshClipLayout,
                      format,
                      sampleCount,
                      kind,
                    ),
                  ),
                ),
            );
          meshClip = await meshVariant('fill');
          trackClip(`${prefix}/mesh-clip-pipeline`, { category: 'render-pipeline' });
          meshJointClip = await meshVariant('joint');
          trackClip(`${prefix}/mesh-joint-clip-pipeline`, { category: 'render-pipeline' });
          meshCoverClip = await createMeshCoverPipelines(meshVariant);
          for (const rule of MESH_COVER_NAMES) {
            trackClip(`${prefix}/mesh-cover-${rule}-clip-pipeline`, {
              category: 'render-pipeline',
            });
          }
          const maskMeshShader = device.createShaderModule({
            label: `${prefix}/mask-mesh-shader`,
            code: MESH_FILL_MASK_SHADER,
          });
          trackClip(`${prefix}/mask-mesh-shader`, { category: 'shader-module' });
          maskMesh = await device.createRenderPipelineAsync(
            maskDescriptor(
              createMeshPipelineDescriptor(
                maskMeshShader,
                meshClipLayout,
                format,
                sampleCount,
                'fill',
              ),
            ),
          );
          trackClip(`${prefix}/mask-mesh-pipeline`, { category: 'render-pipeline' });
          // E39-R7: a winding mask source's stencil pass and covers at the mask format.
          maskStencil = await device.createRenderPipelineAsync(
            createMeshStencilPipelineDescriptor(
              maskMeshShader,
              meshClipLayout,
              CLIP_MASK_FORMAT,
              sampleCount,
              'winding',
            ),
          );
          maskCover = await createMeshRuleCoverPipelines((kind) =>
            device.createRenderPipelineAsync(
              maskDescriptor(
                createMeshPipelineDescriptor(
                  maskMeshShader,
                  meshClipLayout,
                  format,
                  sampleCount,
                  kind,
                ),
              ),
            ),
          );
          for (const name of ['stencil-winding', 'cover-nonzero', 'cover-evenodd']) {
            trackClip(`${prefix}/mask-mesh-${name}-pipeline`, { category: 'render-pipeline' });
          }
        }
        clip = Object.freeze({
          bindGroupLayout: clipBindGroupLayout,
          analytic,
          mesh: meshClip,
          meshJoint: meshJointClip,
          meshCover: meshCoverClip,
          maskAnalytic,
          maskMesh,
          maskStencil,
          maskCover,
          defaultMask,
        });
      } catch {
        defaultMask?.destroy();
        // E22-K5: no clip variant this attempt cached outlives the failure.
        pipelineCache.evict(clipVariantKey(primitivePipelineKey(format, sampleCount, stencil)));
        for (const kind of MESH_PIPELINE_KINDS) {
          pipelineCache.evict(clipVariantKey(meshPipelineKey(format, sampleCount, kind)));
        }
        for (const id of clipTracked) {
          tracked.delete(id);
          try {
            resources.release(id);
          } catch {
            // Accounting cleanup is best effort.
          }
        }
        clip = null;
      }
    }
    // E23 contract, U3: the paint variants, created here like the clip variants and never on
    // the frame path. A failure leaves them unavailable: solid draws are unaffected, and a
    // gradient draw is not drawn.
    let paint: PaintPipelineState | null = null;
    if (options.paintPipeline === true && !disposed) {
      const paintTracked: string[] = [];
      const trackPaint = (id: string, descriptor: ResourceDescriptor) => {
        track(id, descriptor);
        paintTracked.push(id);
      };
      const analyticKey = primitivePipelineKey(format, sampleCount, stencil);
      try {
        // The mesh variants bind the paint group's two storage buffers next to the mesh group's.
        if (
          mesh !== null &&
          safeLimit(device.limits.maxStorageBuffersPerShaderStage, 0) <
            MESH_REQUIRED_STORAGE_BUFFERS_PER_STAGE + 2
        ) {
          throw new Error('Too few storage buffers per stage for the mesh paint variants.');
        }
        const paintBindGroupLayout = device.createBindGroupLayout(
          createPaintBindGroupLayoutDescriptor(),
        );
        trackPaint(`${prefix}/paint-bind-group-layout`, { category: 'bind-group-layout' });
        const emptyLayout = device.createBindGroupLayout({
          label: `${prefix}/paint-empty-bind-group-layout`,
          entries: [],
        });
        trackPaint(`${prefix}/paint-empty-bind-group-layout`, { category: 'bind-group-layout' });
        const emptyBindGroup = device.createBindGroup({
          label: `${prefix}/paint-empty-bind-group`,
          layout: emptyLayout,
          entries: [],
        });
        const layout = (name: string, groups: GPUBindGroupLayout[]) => {
          const created = device.createPipelineLayout({
            label: `${prefix}/${name}`,
            bindGroupLayouts: groups,
          });
          trackPaint(`${prefix}/${name}`, { category: 'pipeline-layout' });
          return created;
        };
        const module = (name: string, code: string) => {
          const created = device.createShaderModule({ label: `${prefix}/${name}`, code });
          trackPaint(`${prefix}/${name}`, { category: 'shader-module' });
          return created;
        };
        const analyticShader = module('paint-shader', PRIMITIVE_ANALYTIC_PAINT_SHADER);
        const analyticLayout = layout('paint-pipeline-layout', [
          bindGroupLayout,
          emptyLayout,
          paintBindGroupLayout,
        ]);
        const analytic = await pipelineCache.getOrCreate(paintVariantKey(analyticKey), () =>
          device.createRenderPipelineAsync(
            variantDescriptor(
              createPrimitivePipelineDescriptor(
                analyticShader,
                analyticLayout,
                format,
                sampleCount,
                stencil,
              ),
              '+paint-v0',
            ),
          ),
        );
        trackPaint(`${prefix}/paint-pipeline`, { category: 'render-pipeline' });
        let analyticClip: GPURenderPipeline | null = null;
        if (clip !== null) {
          const clipShader = module('paint-clip-shader', PRIMITIVE_ANALYTIC_PAINT_CLIP_SHADER);
          const clipLayout = layout('paint-clip-pipeline-layout', [
            bindGroupLayout,
            clip.bindGroupLayout,
            paintBindGroupLayout,
          ]);
          analyticClip = await pipelineCache.getOrCreate(paintClipVariantKey(analyticKey), () =>
            device.createRenderPipelineAsync(
              variantDescriptor(
                createPrimitivePipelineDescriptor(
                  clipShader,
                  clipLayout,
                  format,
                  sampleCount,
                  stencil,
                ),
                '+paint-v0+clip-v0',
              ),
            ),
          );
          trackPaint(`${prefix}/paint-clip-pipeline`, { category: 'render-pipeline' });
        }
        const meshVariants = async (
          shader: GPUShaderModule,
          pipelineLayout: GPUPipelineLayout,
          clipped: boolean,
        ) => {
          const variant = (kind: MeshPipelineKind) => {
            const base = meshPipelineKey(format, sampleCount, kind);
            return pipelineCache!.getOrCreate(
              clipped ? paintClipVariantKey(base) : paintVariantKey(base),
              () =>
                device.createRenderPipelineAsync(
                  variantDescriptor(
                    createMeshPipelineDescriptor(shader, pipelineLayout, format, sampleCount, kind),
                    clipped ? '+paint-v0+clip-v0' : '+paint-v0',
                  ),
                ),
            );
          };
          const suffix = clipped ? 'paint-clip' : 'paint';
          const fill = await variant('fill');
          trackPaint(`${prefix}/mesh-${suffix}-pipeline`, { category: 'render-pipeline' });
          const joint = await variant('joint');
          trackPaint(`${prefix}/mesh-joint-${suffix}-pipeline`, { category: 'render-pipeline' });
          const cover = await createMeshCoverPipelines(variant);
          for (const rule of MESH_COVER_NAMES) {
            trackPaint(`${prefix}/mesh-cover-${rule}-${suffix}-pipeline`, {
              category: 'render-pipeline',
            });
          }
          return [fill, joint, cover] as const;
        };
        let meshPaint: readonly [GPURenderPipeline, GPURenderPipeline, MeshCoverPipelines] | null =
          null;
        let meshPaintClip:
          readonly [GPURenderPipeline, GPURenderPipeline, MeshCoverPipelines] | null = null;
        if (mesh !== null) {
          meshPaint = await meshVariants(
            module('mesh-paint-shader', MESH_FILL_PAINT_SHADER),
            layout('mesh-paint-pipeline-layout', [
              mesh.bindGroupLayout,
              emptyLayout,
              paintBindGroupLayout,
            ]),
            false,
          );
          if (clip !== null) {
            meshPaintClip = await meshVariants(
              module('mesh-paint-clip-shader', MESH_FILL_PAINT_CLIP_SHADER),
              layout('mesh-paint-clip-pipeline-layout', [
                mesh.bindGroupLayout,
                clip.bindGroupLayout,
                paintBindGroupLayout,
              ]),
              true,
            );
          }
        }
        paint = Object.freeze({
          bindGroupLayout: paintBindGroupLayout,
          emptyBindGroup,
          analytic,
          analyticClip,
          mesh: meshPaint?.[0] ?? null,
          meshJoint: meshPaint?.[1] ?? null,
          meshClip: meshPaintClip?.[0] ?? null,
          meshJointClip: meshPaintClip?.[1] ?? null,
          meshCover: meshPaint?.[2] ?? null,
          meshCoverClip: meshPaintClip?.[2] ?? null,
        });
      } catch {
        // The E22-K5 rule: no paint variant this attempt cached outlives the failure.
        pipelineCache.evict(paintVariantKey(analyticKey));
        pipelineCache.evict(paintClipVariantKey(analyticKey));
        for (const kind of MESH_PIPELINE_KINDS) {
          pipelineCache.evict(paintVariantKey(meshPipelineKey(format, sampleCount, kind)));
          pipelineCache.evict(paintClipVariantKey(meshPipelineKey(format, sampleCount, kind)));
        }
        for (const id of paintTracked) {
          tracked.delete(id);
          try {
            resources.release(id);
          } catch {
            // Accounting cleanup is best effort.
          }
        }
        paint = null;
      }
    }
    // E25 contract, U3: the layer variants and the composite pipeline, created here like the
    // paint variants and never on the frame path. A failure, or an adapter with fewer than 4
    // bind groups, leaves them unavailable, and the content of isolated containers is then not
    // drawn (fail closed; the U3 record's departure).
    let layer: LayerPipelineState | null = null;
    if (
      options.layerPipeline === true &&
      !disposed &&
      safeLimit(device.limits.maxBindGroups, 0) >= LAYER_REQUIRED_BIND_GROUPS
    ) {
      const layerTracked: string[] = [];
      const trackLayer = (id: string, descriptor: ResourceDescriptor) => {
        track(id, descriptor);
        layerTracked.push(id);
      };
      const analyticKey = primitivePipelineKey(format, sampleCount, stencil);
      try {
        const layerBindGroupLayout = device.createBindGroupLayout(
          createLayerBindGroupLayoutDescriptor(),
        );
        trackLayer(`${prefix}/layer-bind-group-layout`, { category: 'bind-group-layout' });
        const emptyLayout = device.createBindGroupLayout({
          label: `${prefix}/layer-empty-bind-group-layout`,
          entries: [],
        });
        trackLayer(`${prefix}/layer-empty-bind-group-layout`, { category: 'bind-group-layout' });
        const emptyBindGroup = device.createBindGroup({
          label: `${prefix}/layer-empty-bind-group`,
          layout: emptyLayout,
          entries: [],
        });
        const compositeBindGroupLayout = device.createBindGroupLayout(
          createLayerCompositeBindGroupLayoutDescriptor(),
        );
        trackLayer(`${prefix}/layer-composite-bind-group-layout`, {
          category: 'bind-group-layout',
        });
        const layout = (name: string, groups: GPUBindGroupLayout[]) => {
          const created = device.createPipelineLayout({
            label: `${prefix}/${name}`,
            bindGroupLayouts: [...groups, layerBindGroupLayout],
          });
          trackLayer(`${prefix}/${name}`, { category: 'pipeline-layout' });
          return created;
        };
        const module = (name: string, code: string) => {
          const created = device.createShaderModule({ label: `${prefix}/${name}`, code });
          trackLayer(`${prefix}/${name}`, { category: 'shader-module' });
          return created;
        };
        const compositeModule = module('layer-composite-shader', LAYER_COMPOSITE_SHADER);
        const compositeLayout = layout('layer-composite-pipeline-layout', [
          compositeBindGroupLayout,
          emptyLayout,
          emptyLayout,
        ]);
        const composite = await pipelineCache.getOrCreate(
          layerCompositePipelineKey(format, sampleCount, stencil),
          () =>
            device.createRenderPipelineAsync(
              createLayerCompositePipelineDescriptor(
                compositeModule,
                compositeLayout,
                format,
                sampleCount,
                stencil,
              ),
            ),
        );
        trackLayer(`${prefix}/layer-composite-pipeline`, { category: 'render-pipeline' });
        const analyticVariant = async (
          kind: 'clip' | 'paint' | 'paint-clip',
          code: string,
          groups: GPUBindGroupLayout[],
        ) => {
          const shader = module(`layer-${kind}-shader`, code);
          const pipelineLayout = layout(`layer-${kind}-pipeline-layout`, groups);
          const created = await pipelineCache!.getOrCreate(
            layerVariantBaseKey(analyticKey, kind),
            () =>
              device.createRenderPipelineAsync(
                variantDescriptor(
                  createPrimitivePipelineDescriptor(
                    shader,
                    pipelineLayout,
                    format,
                    sampleCount,
                    stencil,
                  ),
                  `${kind === 'clip' ? '+clip-v0' : kind === 'paint' ? '+paint-v0' : '+paint-v0+clip-v0'}${LAYER_VARIANT_SUFFIX}`,
                ),
              ),
          );
          trackLayer(`${prefix}/layer-${kind}-pipeline`, { category: 'render-pipeline' });
          return created;
        };
        const meshVariants = async (
          kind: LayerVariantBase,
          code: string,
          groups: GPUBindGroupLayout[],
        ) => {
          const shader = module(`mesh-layer-${kind}-shader`, code);
          const pipelineLayout = layout(`mesh-layer-${kind}-pipeline-layout`, groups);
          const suffix = `${kind === 'plain' ? '' : kind === 'clip' ? '+clip-v0' : kind === 'paint' ? '+paint-v0' : '+paint-v0+clip-v0'}${LAYER_VARIANT_SUFFIX}`;
          const variant = (meshKind: MeshPipelineKind) =>
            pipelineCache!.getOrCreate(
              layerVariantBaseKey(meshPipelineKey(format, sampleCount, meshKind), kind),
              () =>
                device.createRenderPipelineAsync(
                  variantDescriptor(
                    createMeshPipelineDescriptor(
                      shader,
                      pipelineLayout,
                      format,
                      sampleCount,
                      meshKind,
                    ),
                    suffix,
                  ),
                ),
            );
          const fill = await variant('fill');
          trackLayer(`${prefix}/mesh-layer-${kind}-pipeline`, { category: 'render-pipeline' });
          const joint = await variant('joint');
          trackLayer(`${prefix}/mesh-joint-layer-${kind}-pipeline`, {
            category: 'render-pipeline',
          });
          const cover = await createMeshCoverPipelines(variant);
          for (const rule of MESH_COVER_NAMES) {
            trackLayer(`${prefix}/mesh-cover-${rule}-layer-${kind}-pipeline`, {
              category: 'render-pipeline',
            });
          }
          return [fill, joint, cover] as const;
        };
        const analyticClip =
          clip === null
            ? null
            : await analyticVariant('clip', PRIMITIVE_ANALYTIC_CLIP_LAYER_SHADER, [
                bindGroupLayout,
                clip.bindGroupLayout,
                emptyLayout,
              ]);
        const analyticPaint =
          paint === null
            ? null
            : await analyticVariant('paint', PRIMITIVE_ANALYTIC_PAINT_LAYER_SHADER, [
                bindGroupLayout,
                emptyLayout,
                paint.bindGroupLayout,
              ]);
        const analyticPaintClip =
          paint === null || clip === null || paint.analyticClip === null
            ? null
            : await analyticVariant('paint-clip', PRIMITIVE_ANALYTIC_PAINT_CLIP_LAYER_SHADER, [
                bindGroupLayout,
                clip.bindGroupLayout,
                paint.bindGroupLayout,
              ]);
        const meshPlain =
          mesh === null
            ? null
            : await meshVariants('plain', MESH_FILL_LAYER_SHADER, [
                mesh.bindGroupLayout,
                emptyLayout,
                emptyLayout,
              ]);
        const meshClip =
          mesh === null || clip?.mesh == null
            ? null
            : await meshVariants('clip', MESH_FILL_CLIP_LAYER_SHADER, [
                mesh.bindGroupLayout,
                clip.bindGroupLayout,
                emptyLayout,
              ]);
        const meshPaint =
          mesh === null || paint?.mesh == null
            ? null
            : await meshVariants('paint', MESH_FILL_PAINT_LAYER_SHADER, [
                mesh.bindGroupLayout,
                emptyLayout,
                paint.bindGroupLayout,
              ]);
        const meshPaintClip =
          mesh === null || paint?.meshClip == null || clip === null
            ? null
            : await meshVariants('paint-clip', MESH_FILL_PAINT_CLIP_LAYER_SHADER, [
                mesh.bindGroupLayout,
                clip.bindGroupLayout,
                paint.bindGroupLayout,
              ]);
        layer = Object.freeze({
          bindGroupLayout: layerBindGroupLayout,
          compositeBindGroupLayout,
          emptyBindGroup,
          emptyLayout,
          composite,
          analyticClip,
          analyticPaint,
          analyticPaintClip,
          mesh: meshPlain?.[0] ?? null,
          meshJoint: meshPlain?.[1] ?? null,
          meshClip: meshClip?.[0] ?? null,
          meshJointClip: meshClip?.[1] ?? null,
          meshPaint: meshPaint?.[0] ?? null,
          meshJointPaint: meshPaint?.[1] ?? null,
          meshPaintClip: meshPaintClip?.[0] ?? null,
          meshJointPaintClip: meshPaintClip?.[1] ?? null,
          meshCover: meshPlain?.[2] ?? null,
          meshCoverClip: meshClip?.[2] ?? null,
          meshCoverPaint: meshPaint?.[2] ?? null,
          meshCoverPaintClip: meshPaintClip?.[2] ?? null,
        });
      } catch {
        // The E22-K5 rule: no layer variant this attempt cached outlives the failure.
        pipelineCache.evict(layerCompositePipelineKey(format, sampleCount, stencil));
        for (const kind of ['clip', 'paint', 'paint-clip'] as const) {
          pipelineCache.evict(layerVariantBaseKey(analyticKey, kind));
        }
        for (const kind of ['plain', 'clip', 'paint', 'paint-clip'] as const) {
          for (const meshKind of MESH_PIPELINE_KINDS) {
            pipelineCache.evict(
              layerVariantBaseKey(meshPipelineKey(format, sampleCount, meshKind), kind),
            );
          }
        }
        for (const id of layerTracked) {
          tracked.delete(id);
          try {
            resources.release(id);
          } catch {
            // Accounting cleanup is best effort.
          }
        }
        layer = null;
      }
    }
    // E28 contract, U3: the text pipelines and the sampler, created here like the layer
    // variants and never on the frame path: the plain variant, the clip one with the clip
    // variants, and the layer and combined ones with the layer pipeline. A failure leaves text
    // unavailable for the generation; text is then not drawn (E28-D1, `'pipeline'`).
    let text: TextPipelineState | null = null;
    if (options.textPipeline === true && !disposed) {
      const textTracked: string[] = [];
      const trackText = (id: string, descriptor: ResourceDescriptor) => {
        track(id, descriptor);
        textTracked.push(id);
      };
      const variants = TEXT_VARIANTS.filter(
        (variant) =>
          (clip !== null || (variant !== 'clip' && variant !== 'clip-layer')) &&
          (layer !== null || (variant !== 'layer' && variant !== 'clip-layer')),
      );
      try {
        const textBindGroupLayout = device.createBindGroupLayout(
          createTextBindGroupLayoutDescriptor(),
        );
        trackText(`${prefix}/text-bind-group-layout`, { category: 'bind-group-layout' });
        const sampler = device.createSampler(createTextSamplerDescriptor());
        trackText(`${prefix}/text-sampler`, { category: 'sampler' });
        const created = new Map<TextVariant, GPURenderPipeline>();
        for (const variant of variants) {
          const clipped = variant === 'clip' || variant === 'clip-layer';
          const layered = variant === 'layer' || variant === 'clip-layer';
          const empty = layer?.emptyLayout;
          const groups: GPUBindGroupLayout[] = [textBindGroupLayout];
          if (clipped) groups.push(clip!.bindGroupLayout);
          if (layered) {
            if (!clipped) groups.push(empty!);
            groups.push(empty!, layer!.bindGroupLayout);
          }
          const name = variant === 'plain' ? 'text' : `text-${variant}`;
          const pipelineLayout = device.createPipelineLayout({
            label: `${prefix}/${name}-pipeline-layout`,
            bindGroupLayouts: groups,
          });
          trackText(`${prefix}/${name}-pipeline-layout`, { category: 'pipeline-layout' });
          const shader = device.createShaderModule({
            label: `${prefix}/${name}-shader`,
            code: textVariantSource(variant),
          });
          trackText(`${prefix}/${name}-shader`, { category: 'shader-module' });
          const pipeline = await pipelineCache.getOrCreate(
            textPipelineKey(format, sampleCount, stencil, variant),
            () =>
              device.createRenderPipelineAsync(
                createTextPipelineDescriptor(
                  shader,
                  pipelineLayout,
                  format,
                  sampleCount,
                  stencil,
                  variant,
                ),
              ),
          );
          trackText(`${prefix}/${name}-pipeline`, { category: 'render-pipeline' });
          created.set(variant, pipeline);
        }
        text = Object.freeze({
          bindGroupLayout: textBindGroupLayout,
          sampler,
          plain: created.get('plain')!,
          clip: created.get('clip') ?? null,
          layer: created.get('layer') ?? null,
          clipLayer: created.get('clip-layer') ?? null,
        });
      } catch {
        // The E22-K5 rule: no text pipeline this attempt cached outlives the failure.
        for (const variant of TEXT_VARIANTS) {
          pipelineCache.evict(textPipelineKey(format, sampleCount, stencil, variant));
        }
        for (const id of textTracked) {
          tracked.delete(id);
          try {
            resources.release(id);
          } catch {
            // Accounting cleanup is best effort.
          }
        }
        text = null;
      }
    }
    // E41 contract, U5: the effect module and its five pipelines, created here like the layer
    // variants and never on the frame path, and only with the layer pipeline (effect roots are
    // layers). A failure leaves them unavailable: effect roots then composite their content
    // as E25 layers, without effects (section 5.3).
    let effect: EffectPipelineState | null = null;
    if (options.effectPipeline === true && layer !== null && !disposed) {
      const effectTracked: string[] = [];
      const shiftedKeys: PipelineCacheKey[] = [];
      const trackEffect = (id: string, descriptor: ResourceDescriptor) => {
        track(id, descriptor);
        effectTracked.push(id);
      };
      try {
        const effectBindGroupLayout = device.createBindGroupLayout(
          createEffectBindGroupLayoutDescriptor(),
        );
        trackEffect(`${prefix}/effect-bind-group-layout`, { category: 'bind-group-layout' });
        const pipelineLayout = device.createPipelineLayout({
          label: `${prefix}/effect-pipeline-layout`,
          bindGroupLayouts: [effectBindGroupLayout],
        });
        trackEffect(`${prefix}/effect-pipeline-layout`, { category: 'pipeline-layout' });
        const shader = device.createShaderModule({
          label: `${prefix}/effect-shader`,
          code: EFFECT_SHADER,
        });
        trackEffect(`${prefix}/effect-shader`, { category: 'shader-module' });
        const pipelines = new Map<EffectPassKind, GPURenderPipeline>();
        for (const kind of EFFECT_PASS_KINDS) {
          const created = await pipelineCache.getOrCreate(effectPipelineKey(format, kind), () =>
            device.createRenderPipelineAsync(
              createEffectPipelineDescriptor(shader, pipelineLayout, format, kind),
            ),
          );
          trackEffect(`${prefix}/effect-${kind}-pipeline`, { category: 'render-pipeline' });
          pipelines.set(kind, created);
        }
        const shifted = await createShiftedLayerPipelines(
          device,
          pipelineCache,
          format,
          sampleCount,
          stencil,
          prefix,
          trackEffect,
          shiftedKeys,
          {
            analytic: bindGroupLayout,
            mesh: mesh?.bindGroupLayout ?? null,
            clip: clip?.bindGroupLayout ?? null,
            paint: paint?.bindGroupLayout ?? null,
            text: text?.bindGroupLayout ?? null,
          },
          layer,
          text,
        );
        effect = Object.freeze({
          bindGroupLayout: effectBindGroupLayout,
          pipelines,
          shifted,
          compositeClip: shifted.targetCompositeClip,
        });
      } catch {
        // The E22-K5 rule: no effect pipeline this attempt cached outlives the failure.
        for (const kind of EFFECT_PASS_KINDS) pipelineCache.evict(effectPipelineKey(format, kind));
        for (const key of shiftedKeys) pipelineCache.evict(key);
        for (const id of effectTracked) {
          tracked.delete(id);
          try {
            resources.release(id);
          } catch {
            // Accounting cleanup is best effort.
          }
        }
        effect = null;
      }
    }
    // V-35 contract, V35-K4 and K5: the backdrop snapshot pipeline and the blend composite
    // variants, created here like the effect pipelines and never on the frame path, and only
    // with the layer pipeline (blend roots are layers). A failure leaves them unavailable: blend
    // roots then draw as `normal` and isolating containers as `passThrough` (V35-K7).
    let blend: BlendPipelineState | null = null;
    if (options.blendPipeline === true && layer !== null && !disposed) {
      const blendTracked: string[] = [];
      const blendKeys: PipelineCacheKey[] = [];
      const trackBlend = (id: string, descriptor: ResourceDescriptor) => {
        track(id, descriptor);
        blendTracked.push(id);
      };
      try {
        const snapshotBindGroupLayout = device.createBindGroupLayout(
          createBackdropSnapshotBindGroupLayoutDescriptor(sampleCount),
        );
        trackBlend(`${prefix}/backdrop-snapshot-bind-group-layout`, {
          category: 'bind-group-layout',
        });
        const snapshotLayout = device.createPipelineLayout({
          label: `${prefix}/backdrop-snapshot-pipeline-layout`,
          bindGroupLayouts: [snapshotBindGroupLayout],
        });
        trackBlend(`${prefix}/backdrop-snapshot-pipeline-layout`, { category: 'pipeline-layout' });
        const snapshotModule = device.createShaderModule({
          label: `${prefix}/backdrop-snapshot-shader`,
          code: backdropSnapshotShader(sampleCount),
        });
        trackBlend(`${prefix}/backdrop-snapshot-shader`, { category: 'shader-module' });
        const snapshotKey = backdropSnapshotPipelineKey(format, sampleCount);
        blendKeys.push(snapshotKey);
        const snapshot = await pipelineCache.getOrCreate(snapshotKey, () =>
          device.createRenderPipelineAsync(
            createBackdropSnapshotPipelineDescriptor(
              snapshotModule,
              snapshotLayout,
              format,
              sampleCount,
            ),
          ),
        );
        trackBlend(`${prefix}/backdrop-snapshot-pipeline`, { category: 'render-pipeline' });
        const compositeBindGroupLayout = device.createBindGroupLayout(
          createBlendCompositeBindGroupLayoutDescriptor(),
        );
        trackBlend(`${prefix}/blend-composite-bind-group-layout`, {
          category: 'bind-group-layout',
        });
        const created = new Map<BlendCompositeVariant, GPURenderPipeline>();
        for (const variant of BLEND_COMPOSITE_VARIANTS) {
          const clipped = variant === 'clip' || variant === 'clip-shifted';
          const shifted = variant === 'shifted' || variant === 'clip-shifted';
          if (clipped && clip === null) continue;
          if (shifted && effect === null) continue;
          const pipelineLayout = device.createPipelineLayout({
            label: `${prefix}/blend-composite-${variant}-pipeline-layout`,
            bindGroupLayouts: [
              compositeBindGroupLayout,
              clipped ? clip!.bindGroupLayout : layer.emptyLayout,
              layer.emptyLayout,
              layer.bindGroupLayout,
            ],
          });
          trackBlend(`${prefix}/blend-composite-${variant}-pipeline-layout`, {
            category: 'pipeline-layout',
          });
          const module = device.createShaderModule({
            label: `${prefix}/blend-composite-${variant}-shader`,
            code: blendCompositeVariantSource(variant),
          });
          trackBlend(`${prefix}/blend-composite-${variant}-shader`, {
            category: 'shader-module',
          });
          const key = blendCompositePipelineKey(format, sampleCount, stencil, variant);
          blendKeys.push(key);
          const pipeline = await pipelineCache.getOrCreate(key, () =>
            device.createRenderPipelineAsync(
              createBlendCompositePipelineDescriptor(
                module,
                pipelineLayout,
                format,
                sampleCount,
                stencil,
                variant,
              ),
            ),
          );
          trackBlend(`${prefix}/blend-composite-${variant}-pipeline`, {
            category: 'render-pipeline',
          });
          created.set(variant, pipeline);
        }
        blend = Object.freeze({
          snapshotBindGroupLayout,
          snapshot,
          compositeBindGroupLayout,
          plain: created.get('plain')!,
          clip: created.get('clip') ?? null,
          shifted: created.get('shifted') ?? null,
          clipShifted: created.get('clip-shifted') ?? null,
        });
      } catch {
        // The E22-K5 rule: no blend pipeline this attempt cached outlives the failure.
        for (const key of blendKeys) pipelineCache.evict(key);
        for (const id of blendTracked) {
          tracked.delete(id);
          try {
            resources.release(id);
          } catch {
            // Accounting cleanup is best effort.
          }
        }
        blend = null;
      }
    }
    if (disposed || vertexBuffer === undefined || indexBuffer === undefined) {
      throw new Error('Primitive scene creation completed after disposal.');
    }
    const staticIds = Object.freeze([...tracked]);
    scene = new NativePrimitiveScene(
      device,
      context,
      format,
      generation,
      sampleCount,
      pipelineCache,
      pipeline,
      bindGroupLayout,
      vertexBuffer,
      indexBuffer,
      resources,
      staticIds,
      mesh,
      meshShaderModulesCreated,
      count,
      stencil,
      clip,
      paint,
      layer,
      options.layerTileSizeForTesting,
      text,
      effect,
      options.effectContentForTesting === true,
      blend,
    );
    vertexBuffer = undefined;
    indexBuffer = undefined;
    pipelineCache = undefined;
    tracked.clear();
    return Object.freeze({ scene, fellBackFrom4x });
  })().catch((error: unknown) => {
    releasePending();
    throw error instanceof Error
      ? error
      : new Error('Primitive scene creation failed.', { cause: error });
  });

  return Object.freeze({ result, dispose });
}

/**
 * P4 contract, U4: a mask pass pipeline, its base descriptor drawing into the `r8unorm` mask
 * texture under the same blend and sample count.
 */
function maskDescriptor(base: GPURenderPipelineDescriptor): GPURenderPipelineDescriptor {
  const fragment = base.fragment!;
  return {
    ...base,
    label: `${base.label ?? 'vector-studio/pipeline'}+mask-v0`,
    fragment: {
      ...fragment,
      targets: [...fragment.targets].map((target) => ({ ...target!, format: CLIP_MASK_FORMAT })),
    },
  };
}

/** E23 contract, U3: a paint variant's descriptor, labelled apart from its base pipeline. */
function variantDescriptor(
  base: GPURenderPipelineDescriptor,
  suffix: string,
): GPURenderPipelineDescriptor {
  return { ...base, label: `${base.label ?? 'vector-studio/pipeline'}${suffix}` };
}

/** E39-R8: a variant's two rule covers, created through its own variant factory. */
async function createMeshRuleCoverPipelines(
  variant: (kind: 'cover-nonzero' | 'cover-evenodd') => Promise<GPURenderPipeline>,
): Promise<MeshMaskCoverPipelines> {
  const nonzero = await variant('cover-nonzero');
  const evenodd = await variant('cover-evenodd');
  return Object.freeze({ nonzero, evenodd });
}

/** E39-R8: a variant's rule covers and E39-R6's five joint covers. */
async function createMeshCoverPipelines(
  variant: (kind: MeshPipelineKind) => Promise<GPURenderPipeline>,
): Promise<MeshCoverPipelines> {
  const rules = await createMeshRuleCoverPipelines(variant);
  const joint: Partial<Record<MeshJointCover, GPURenderPipeline>> = {};
  for (const cover of MESH_JOINT_COVERS) joint[cover] = await variant(meshJointCoverKind(cover));
  return Object.freeze({ ...rules, ...(joint as Record<MeshJointCover, GPURenderPipeline>) });
}

/** The tracked names of a full cover set (two rule covers, five joint covers). */
const MESH_COVER_NAMES: readonly string[] = Object.freeze([
  'nonzero',
  'evenodd',
  ...MESH_JOINT_COVERS,
]);

/**
 * E41 U5b: the shifted layer variants (shifted-layer-pipeline.ts). A variant exists exactly when
 * E25's layer variant does, plus the plain analytic one and, with the mesh path, the stencil
 * pass pipelines over the plain mesh module. Each pipeline's key goes to `keys` before it is
 * created, so a failure can evict every one.
 */
async function createShiftedLayerPipelines(
  device: GPUDevice,
  pipelineCache: PipelineCache<GPURenderPipeline>,
  format: PrimitiveTargetFormat,
  sampleCount: 1 | 4,
  stencil: boolean,
  prefix: string,
  track: (id: string, descriptor: ResourceDescriptor) => void,
  keys: PipelineCacheKey[],
  layouts: Readonly<{
    analytic: GPUBindGroupLayout;
    mesh: GPUBindGroupLayout | null;
    clip: GPUBindGroupLayout | null;
    paint: GPUBindGroupLayout | null;
    text: GPUBindGroupLayout | null;
  }>,
  layer: LayerPipelineState,
  text: TextPipelineState | null,
): Promise<ShiftedLayerPipelines> {
  const empty = layer.emptyLayout;
  let modules = 0;
  let count = 0;
  const module = (name: string, code: string) => {
    const created = device.createShaderModule({ label: `${prefix}/${name}`, code });
    track(`${prefix}/${name}`, { category: 'shader-module' });
    modules += 1;
    return created;
  };
  const pipelineLayout = (name: string, groups: GPUBindGroupLayout[]) => {
    const created = device.createPipelineLayout({
      label: `${prefix}/${name}`,
      bindGroupLayouts: [...groups, layer.bindGroupLayout],
    });
    track(`${prefix}/${name}`, { category: 'pipeline-layout' });
    return created;
  };
  const pipeline = async (
    name: string,
    key: PipelineCacheKey,
    descriptor: () => GPURenderPipelineDescriptor,
  ) => {
    keys.push(key);
    const created = await pipelineCache.getOrCreate(key, () =>
      device.createRenderPipelineAsync(descriptor()),
    );
    track(`${prefix}/${name}`, { category: 'render-pipeline' });
    count += 1;
    return created;
  };
  const suffix = (kind: LayerVariantBase) =>
    `${kind === 'plain' ? '' : kind === 'clip' ? '+clip-v0' : kind === 'paint' ? '+paint-v0' : '+paint-v0+clip-v0'}${LAYER_VARIANT_SUFFIX}${SHIFTED_LAYER_VARIANT_SUFFIX}`;
  const baseKey = (key: PipelineCacheKey, kind: LayerVariantBase) =>
    kind === 'plain'
      ? key
      : kind === 'clip'
        ? clipVariantKey(key)
        : kind === 'paint'
          ? paintVariantKey(key)
          : paintClipVariantKey(key);

  const compositeLayout = pipelineLayout('shifted-composite-pipeline-layout', [
    layer.compositeBindGroupLayout,
    empty,
    empty,
  ]);
  const compositeModule = module('shifted-composite-shader', LAYER_COMPOSITE_SHIFTED_SHADER);
  const composite = await pipeline(
    'shifted-composite-pipeline',
    shiftedCompositeKey(layerCompositePipelineKey(format, sampleCount, stencil)),
    () => ({
      ...createLayerCompositePipelineDescriptor(
        compositeModule,
        compositeLayout,
        format,
        sampleCount,
        stencil,
      ),
      label: `vector-studio/e25-layer-composite-${stencil ? 'stencil-' : ''}${sampleCount}x${SHIFTED_LAYER_VARIANT_SUFFIX}`,
    }),
  );

  // E41 U5c: the effect composite's clip variants, for a pass of E25's (main or layer) and for
  // a shifted pass (a root inside a root); only with the clip variants.
  const compositeClipVariant = async (shifted: boolean) => {
    const shader = module(
      `effect-composite-clip${shifted ? '-shifted' : ''}-shader`,
      shifted ? EFFECT_COMPOSITE_CLIP_SHIFTED_SHADER : EFFECT_COMPOSITE_CLIP_SHADER,
    );
    const layout = pipelineLayout(
      `effect-composite-clip${shifted ? '-shifted' : ''}-pipeline-layout`,
      [layer.compositeBindGroupLayout, layouts.clip!, empty],
    );
    return pipeline(
      `effect-composite-clip${shifted ? '-shifted' : ''}-pipeline`,
      (shifted ? effectCompositeClipShiftedKey : effectCompositeClipKey)(
        format,
        sampleCount,
        stencil,
      ),
      () =>
        createEffectCompositeClipPipelineDescriptor(
          shader,
          layout,
          format,
          sampleCount,
          stencil,
          shifted,
        ),
    );
  };
  const targetCompositeClip = layouts.clip === null ? null : await compositeClipVariant(false);
  const compositeClip = layouts.clip === null ? null : await compositeClipVariant(true);

  const analyticKey = primitivePipelineKey(format, sampleCount, stencil);
  const analyticVariant = async (
    kind: LayerVariantBase,
    code: string,
    groups: GPUBindGroupLayout[],
  ) => {
    const shader = module(`shifted-${kind}-shader`, code);
    const layout = pipelineLayout(`shifted-${kind}-pipeline-layout`, groups);
    return pipeline(
      `shifted-${kind}-pipeline`,
      shiftedLayerVariantKey(baseKey(analyticKey, kind)),
      () =>
        variantDescriptor(
          createPrimitivePipelineDescriptor(shader, layout, format, sampleCount, stencil),
          suffix(kind),
        ),
    );
  };
  const { analytic: analyticLayout, mesh: meshLayout, clip, paint } = layouts;
  const analytic = await analyticVariant('plain', PRIMITIVE_ANALYTIC_SHIFTED_SHADER, [
    analyticLayout,
    empty,
    empty,
  ]);
  const analyticClip =
    layer.analyticClip === null
      ? null
      : await analyticVariant('clip', PRIMITIVE_ANALYTIC_CLIP_SHIFTED_SHADER, [
          analyticLayout,
          clip!,
          empty,
        ]);
  const analyticPaint =
    layer.analyticPaint === null
      ? null
      : await analyticVariant('paint', PRIMITIVE_ANALYTIC_PAINT_SHIFTED_SHADER, [
          analyticLayout,
          empty,
          paint!,
        ]);
  const analyticPaintClip =
    layer.analyticPaintClip === null
      ? null
      : await analyticVariant('paint-clip', PRIMITIVE_ANALYTIC_PAINT_CLIP_SHIFTED_SHADER, [
          analyticLayout,
          clip!,
          paint!,
        ]);

  const meshVariants = async (
    kind: LayerVariantBase,
    code: string,
    groups: GPUBindGroupLayout[],
  ) => {
    const shader = module(`shifted-mesh-${kind}-shader`, code);
    const layout = pipelineLayout(`shifted-mesh-${kind}-pipeline-layout`, groups);
    const variant = (meshKind: MeshPipelineKind) =>
      pipeline(
        `shifted-mesh-${meshKind}-${kind}-pipeline`,
        shiftedLayerVariantKey(baseKey(meshPipelineKey(format, sampleCount, meshKind), kind)),
        () =>
          variantDescriptor(
            createMeshPipelineDescriptor(shader, layout, format, sampleCount, meshKind),
            suffix(kind),
          ),
      );
    const fill = await variant('fill');
    const joint = await variant('joint');
    const cover = await createMeshCoverPipelines(variant);
    return { fill, joint, cover, shader, layout };
  };
  const meshPlain =
    layer.mesh === null || meshLayout === null
      ? null
      : await meshVariants('plain', MESH_FILL_SHIFTED_SHADER, [meshLayout, empty, empty]);
  const meshClip =
    layer.meshClip === null
      ? null
      : await meshVariants('clip', MESH_FILL_CLIP_SHIFTED_SHADER, [meshLayout!, clip!, empty]);
  const meshPaint =
    layer.meshPaint === null
      ? null
      : await meshVariants('paint', MESH_FILL_PAINT_SHIFTED_SHADER, [meshLayout!, empty, paint!]);
  const meshPaintClip =
    layer.meshPaintClip === null
      ? null
      : await meshVariants('paint-clip', MESH_FILL_PAINT_CLIP_SHIFTED_SHADER, [
          meshLayout!,
          clip!,
          paint!,
        ]);
  // E39-R1: the stencil passes over the plain mesh module, with its full layout.
  let meshStencil: MeshStencilPipelines | null = null;
  if (meshPlain !== null) {
    const created: Partial<Record<MeshStencilKind, GPURenderPipeline>> = {};
    for (const kind of MESH_STENCIL_KINDS) {
      created[kind] = await pipeline(
        `shifted-mesh-stencil-${kind}-pipeline`,
        shiftedLayerVariantKey(meshStencilPipelineKey(format, sampleCount, kind)),
        () =>
          variantDescriptor(
            createMeshStencilPipelineDescriptor(
              meshPlain.shader,
              meshPlain.layout,
              format,
              sampleCount,
              kind,
            ),
            `${LAYER_VARIANT_SUFFIX}${SHIFTED_LAYER_VARIANT_SUFFIX}`,
          ),
      );
    }
    meshStencil = Object.freeze(created as Record<MeshStencilKind, GPURenderPipeline>);
  }

  const textVariant = async (variant: 'layer' | 'clip-layer') => {
    const clipped = variant === 'clip-layer';
    const shader = module(
      `shifted-text${clipped ? '-clip' : ''}-shader`,
      clipped ? TEXT_CLIP_SHIFTED_SHADER : TEXT_SHIFTED_SHADER,
    );
    const layout = pipelineLayout(`shifted-text${clipped ? '-clip' : ''}-pipeline-layout`, [
      layouts.text!,
      clipped ? clip! : empty,
      empty,
    ]);
    return pipeline(
      `shifted-text${clipped ? '-clip' : ''}-pipeline`,
      shiftedLayerVariantKey(
        textPipelineKey(format, sampleCount, stencil, clipped ? 'clip' : 'plain'),
      ),
      () =>
        variantDescriptor(
          createTextPipelineDescriptor(shader, layout, format, sampleCount, stencil, variant),
          SHIFTED_LAYER_VARIANT_SUFFIX,
        ),
    );
  };
  const textPlain = text?.layer == null ? null : await textVariant('layer');
  const textClip = text?.clipLayer == null ? null : await textVariant('clip-layer');

  return Object.freeze({
    composite,
    compositeClip,
    targetCompositeClip,
    analytic,
    analyticClip,
    analyticPaint,
    analyticPaintClip,
    mesh: meshPlain?.fill ?? null,
    meshJoint: meshPlain?.joint ?? null,
    meshClip: meshClip?.fill ?? null,
    meshJointClip: meshClip?.joint ?? null,
    meshPaint: meshPaint?.fill ?? null,
    meshJointPaint: meshPaint?.joint ?? null,
    meshPaintClip: meshPaintClip?.fill ?? null,
    meshJointPaintClip: meshPaintClip?.joint ?? null,
    meshCover: meshPlain?.cover ?? null,
    meshCoverClip: meshClip?.cover ?? null,
    meshCoverPaint: meshPaint?.cover ?? null,
    meshCoverPaintClip: meshPaintClip?.cover ?? null,
    stencil: meshStencil,
    text: textPlain,
    textClip,
    fullLayouts: true,
    modules,
    count,
  });
}

/** E39-R1: the stencil pass pipelines at one target format, cached by their keys. */
async function createMeshStencilPipelines(
  pipelineCache: PipelineCache<GPURenderPipeline>,
  device: GPUDevice,
  shader: GPUShaderModule,
  layout: GPUPipelineLayout,
  format: GPUTextureFormat,
  sampleCount: 1 | 4,
): Promise<MeshStencilPipelines> {
  const create = (kind: MeshStencilKind) =>
    pipelineCache.getOrCreate(meshStencilPipelineKey(format, sampleCount, kind), () =>
      device.createRenderPipelineAsync(
        createMeshStencilPipelineDescriptor(shader, layout, format, sampleCount, kind),
      ),
    );
  const pipelines: Partial<Record<MeshStencilKind, GPURenderPipeline>> = {};
  for (const kind of MESH_STENCIL_KINDS) pipelines[kind] = await create(kind);
  return Object.freeze(pipelines as Record<MeshStencilKind, GPURenderPipeline>);
}

/** P4 contract, U3: a clip variant's descriptor, labelled apart from its base pipeline. */
function clipDescriptor(base: GPURenderPipelineDescriptor): GPURenderPipelineDescriptor {
  return { ...base, label: `${base.label ?? 'vector-studio/pipeline'}+clip-v0` };
}

/**
 * E10 contract, section 5: the count pipelines over MESH_COUNT_SHADER with the mesh pipeline
 * layout, and at 4x the readout pipeline. Created at initialization and recovery only.
 */
async function createCountPipelines(
  device: GPUDevice,
  meshPipelineLayout: GPUPipelineLayout,
  resetShader: GPUShaderModule,
  sampleCount: 1 | 4,
  prefix: string,
  track: (id: string, descriptor: ResourceDescriptor) => void,
): Promise<CountPipelineState> {
  const module = device.createShaderModule({
    label: `${prefix}/e10-count-shader`,
    code: MESH_COUNT_SHADER,
  });
  track(`${prefix}/e10-count-shader`, { category: 'shader-module' });
  const additive = { srcFactor: 'one', dstFactor: 'one', operation: 'add' } as const;
  const countPipeline = (vertexEntryPoint: string, kind: 'fill' | 'joint') =>
    device.createRenderPipelineAsync({
      label: `vector-studio/e10-count-${kind}-${sampleCount}x`,
      layout: meshPipelineLayout,
      vertex: { module, entryPoint: vertexEntryPoint, buffers: [] },
      fragment: {
        module,
        entryPoint: MESH_COUNT_FRAGMENT_ENTRY_POINT,
        targets: [{ format: 'rgba16float', blend: { color: additive, alpha: additive } }],
      },
      primitive: { topology: 'triangle-list', frontFace: 'ccw', cullMode: 'none' },
      // E17 contract, section 3: the count pass replays the mesh draws' write-once stencil.
      depthStencil: meshWriteOnceStencilState(),
      multisample: { count: sampleCount, mask: 0xffffffff, alphaToCoverageEnabled: false },
    });
  const fill = await countPipeline('meshVertexMain', 'fill');
  track(`${prefix}/e10-count-fill-pipeline`, { category: 'render-pipeline' });
  // E39-R9: the stencil pass and the covers at the count target, over the count module (its
  // vertex entry and meshStencilFragmentMain are MESH_FILL_SHADER's). The covers write 1 with
  // no discard under the cover stencil states.
  const stencilPipelines: Partial<Record<MeshStencilKind, GPURenderPipeline>> = {};
  for (const kind of MESH_STENCIL_KINDS) {
    stencilPipelines[kind] = await device.createRenderPipelineAsync(
      createMeshStencilPipelineDescriptor(
        module,
        meshPipelineLayout,
        'rgba16float',
        sampleCount,
        kind,
      ),
    );
  }
  const stencil = Object.freeze(stencilPipelines as Record<MeshStencilKind, GPURenderPipeline>);
  const coverPipeline = (name: MeshCoverRule | MeshJointCover) =>
    device.createRenderPipelineAsync({
      label: `vector-studio/e39-count-cover-${name}-${sampleCount}x`,
      layout: meshPipelineLayout,
      vertex: { module, entryPoint: 'meshVertexMain', buffers: [] },
      fragment: {
        module,
        entryPoint: MESH_COUNT_FRAGMENT_ENTRY_POINT,
        targets: [{ format: 'rgba16float', blend: { color: additive, alpha: additive } }],
      },
      primitive: { topology: 'triangle-list', frontFace: 'ccw', cullMode: 'none' },
      depthStencil:
        name === 'nonzero' || name === 'evenodd'
          ? meshCoverStencilState(name)
          : meshJointCoverStencilState(name),
      multisample: { count: sampleCount, mask: 0xffffffff, alphaToCoverageEnabled: false },
    });
  const coverPipelines: Partial<Record<MeshCoverRule | MeshJointCover, GPURenderPipeline>> = {};
  for (const name of MESH_COVER_NAMES as readonly (MeshCoverRule | MeshJointCover)[]) {
    coverPipelines[name] = await coverPipeline(name);
  }
  const cover = Object.freeze(
    coverPipelines as Record<MeshCoverRule | MeshJointCover, GPURenderPipeline>,
  );
  for (const name of [
    ...MESH_STENCIL_KINDS.map((kind) => `stencil-${kind}`),
    ...MESH_COVER_NAMES.map((name) => `cover-${name}`),
  ]) {
    track(`${prefix}/e39-count-${name}-pipeline`, { category: 'render-pipeline' });
  }
  const joint = await countPipeline(MESH_JOINT_VERTEX_ENTRY_POINT, 'joint');
  track(`${prefix}/e10-count-joint-pipeline`, { category: 'render-pipeline' });
  const reset = await device.createRenderPipelineAsync(
    createMeshStencilResetPipelineDescriptor(
      resetShader,
      'rgba16float',
      sampleCount,
      `vector-studio/e10-count-stencil-reset-${sampleCount}x`,
    ),
  );
  track(`${prefix}/e10-count-stencil-reset-pipeline`, { category: 'render-pipeline' });
  if (sampleCount === 1)
    return Object.freeze({ fill, joint, reset, stencil, cover, readout: null });
  const layout = device.createBindGroupLayout({
    label: `${prefix}/e10-count-readout-layout`,
    entries: [
      {
        binding: 0,
        visibility: FRAGMENT_STAGE,
        texture: { sampleType: 'unfilterable-float', multisampled: true },
      },
    ],
  });
  track(`${prefix}/e10-count-readout-layout`, { category: 'bind-group-layout' });
  const readoutModule = device.createShaderModule({
    label: `${prefix}/e10-count-readout-shader`,
    code: MESH_COUNT_READOUT_SHADER,
  });
  track(`${prefix}/e10-count-readout-shader`, { category: 'shader-module' });
  const pipeline = await device.createRenderPipelineAsync({
    label: 'vector-studio/e10-count-readout',
    layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
    vertex: { module: readoutModule, entryPoint: 'countReadoutVertexMain' },
    fragment: {
      module: readoutModule,
      entryPoint: 'countReadoutFragmentMain',
      targets: [{ format: 'rgba16float' }],
    },
    primitive: { topology: 'triangle-list' },
  });
  track(`${prefix}/e10-count-readout-pipeline`, { category: 'render-pipeline' });
  return Object.freeze({
    fill,
    joint,
    reset,
    stencil,
    cover,
    readout: Object.freeze({ pipeline, layout }),
  });
}
