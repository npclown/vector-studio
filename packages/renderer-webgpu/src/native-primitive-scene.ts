import type { ResourceDescriptor } from '@vector-studio/contracts';
import type {
  ClipPacketPart,
  MeshFillDraw,
  MeshPacketPart,
  MeshReceiptPart,
  MeshReceiptResource,
  MeshResourceId,
  PrimitivePacket,
  PrimitiveReceipt,
  PrimitiveRecordVersion,
  PrimitiveResourceId,
  PrimitiveSubmitResult,
  PrimitiveTarget,
} from '@vector-studio/renderer-core';

import {
  CLIP_BINDINGS,
  CLIP_BIND_GROUP_INDEX,
  CLIP_FRAME_SIZE,
  CLIP_STATE_SIZE,
  MESH_FILL_CLIP_SHADER,
  PRIMITIVE_ANALYTIC_CLIP_SHADER,
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
  meshStencilStep,
  meshWriteOnceStencilState,
} from './mesh-pipeline.js';
import { PipelineCache } from './pipeline-cache.js';
import { PRIMITIVE_ANALYTIC_SHADER } from './primitive-analytic-shader.js';
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
const FRAGMENT_STAGE = 0x2;

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
}

/** P4 contract, U3: the rect-clip pipeline variants created at initialization or recovery. */
interface ClipPipelineState {
  readonly bindGroupLayout: GPUBindGroupLayout;
  readonly analytic: GPURenderPipeline;
  /** Null without the mesh path. */
  readonly mesh: GPURenderPipeline | null;
  readonly meshJoint: GPURenderPipeline | null;
}

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
}> | null;

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
  ) {
    this.#mesh = mesh;
    this.#clip = clip;
    this.clipPipelineAvailable = clip !== null;
    this.#count = count;
    this.#stencil = stencil;
    this.meshPipelineAvailable = mesh !== null;
    // E10 contract, section 5: one count module (two at 4x, with the readout) and two count
    // pipelines (three at 4x); none without the countPass option. E17 section 3: the mesh path
    // adds the reset pipeline, and the count pass its own reset pipeline over the same module.
    const countModules = count === null ? 0 : count.readout === null ? 1 : 2;
    // P4 contract, U3: one clip module and pipeline, two modules and three pipelines with the
    // mesh path; none without the clipPipeline option.
    const clipModules = clip === null ? 0 : clip.mesh === null ? 1 : 2;
    this.shaderModulesCreated = 1 + meshShaderModulesCreated + countModules + clipModules;
    this.pipelinesCreated =
      (mesh === null ? 1 : 4) +
      (count === null ? 0 : countModules + 2) +
      (clip === null ? 0 : clip.mesh === null ? 1 : 3);
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
        usage: RENDER_ATTACHMENT_USAGE,
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
    let mesh: ValidatedMesh | null = null;
    if (packet.mesh !== undefined) {
      try {
        mesh = this.#preflightMesh(packet.mesh, packet.draws.length);
      } catch (error) {
        if (validated.createdArena) this.#releaseArena(arena);
        return frozenResult(
          error instanceof AllocationError ? 'allocation-failed' : 'invalid-packet',
        );
      }
    }
    const meshArena = mesh !== null && !mesh.skipped ? mesh.arena : null;
    const meshDraws = mesh !== null && !mesh.skipped ? mesh.draws : [];
    let clip: ValidatedClip;
    try {
      clip = this.#preflightClip(packet, meshDraws);
    } catch (error) {
      if (validated.createdArena) this.#releaseArena(arena);
      if (mesh !== null && !mesh.skipped && mesh.createdArena && mesh.arena !== null) {
        this.#releaseArena(mesh.arena);
      }
      return frozenResult(
        error instanceof AllocationError ? 'allocation-failed' : 'invalid-packet',
      );
    }
    try {
      if (clip !== null) this.#writeClip(clip);
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
      const stencilView = this.#stencilAttachment?.createView();
      const pass = encoder.beginRenderPass({
        label: 'vector-studio/primitive-pass',
        colorAttachments: [
          {
            view: multisampleView ?? presentationView,
            ...(multisampleView === undefined ? {} : { resolveTarget: presentationView }),
            clearValue: { r: 0, g: 0, b: 0, a: 1 },
            loadOp: 'clear',
            storeOp: multisampleView === undefined ? 'store' : 'discard',
          },
        ],
        // E17 contract, section 3: cleared to 0 each frame, not stored.
        ...(stencilView === undefined
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
      // P4 contract, U3: a clipped draw uses its pipeline's clip variant, with the clip bind
      // group at its state's dynamic offset; a draw without a clip state is encoded exactly as
      // before. Without the clip variants a clipped draw is not drawn (fail closed).
      const clipPipelines = clip === null ? null : this.#clip;
      let clipBoundState = 0;
      const bindClip = (state: number) => {
        if (state === clipBoundState) return;
        pass.setBindGroup(CLIP_BIND_GROUP_INDEX, clip!.buffer.bindGroup, [state * clip!.stride]);
        clipBoundState = state;
      };
      const bindAnalytic = (clipped: boolean) => {
        pass.setPipeline(clipped ? clipPipelines!.analytic : this.#pipeline);
        pass.setBindGroup(0, arena.bindGroup);
        pass.setVertexBuffer(0, this.#vertexBuffer, 0, 32);
        pass.setIndexBuffer(this.#indexBuffer, 'uint16', 0, 12);
        clipBoundState = 0;
      };
      bindAnalytic(false);
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
      const drawMeshesAt = (position: number) => {
        while (meshDraws[nextMeshDraw]?.position === position) {
          const draw = meshDraws[nextMeshDraw]!;
          const joint = draw.composite === 'joint-fill';
          const state = draw.clipState ?? 0;
          const step = meshStencilStep(nextMeshDraw);
          nextMeshDraw += 1;
          if (step.reset) {
            pass.setPipeline(this.#mesh!.resetPipeline);
            pass.draw(3);
            bound = null;
          }
          if (state !== 0 && (clipPipelines?.mesh ?? null) === null) continue;
          const kind = `${joint ? 'joint' : 'fill'}${state !== 0 ? '+clip' : ''}`;
          const pipeline =
            state === 0
              ? joint
                ? this.#mesh!.jointPipeline
                : this.#mesh!.pipeline
              : joint
                ? clipPipelines!.meshJoint!
                : clipPipelines!.mesh!;
          if (bound === null || bound.startsWith('analytic')) {
            pass.setPipeline(pipeline);
            pass.setBindGroup(0, meshArena!.bindGroup);
            clipBoundState = 0;
          } else if (bound !== kind) {
            pass.setPipeline(pipeline);
          }
          bound = kind;
          if (state !== 0) bindClip(state);
          pass.setStencilReference(step.reference);
          pass.draw(3 * draw.triangleCount, 1, 3 * draw.firstTriangle, draw.instance);
        }
      };
      packet.draws.forEach((draw, index) => {
        drawMeshesAt(index);
        const state = draw.clipState ?? 0;
        if (state !== 0 && clipPipelines === null) return;
        const kind = state === 0 ? 'analytic' : 'analytic+clip';
        if (bound === null || !bound.startsWith('analytic')) {
          bindAnalytic(state !== 0);
        } else if (bound !== kind) {
          pass.setPipeline(state === 0 ? this.#pipeline : clipPipelines!.analytic);
        }
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
      this.#observeCompletion();
      return Object.freeze({
        status: 'submitted',
        receipt: createReceipt(
          packet,
          serial,
          validated.receiptResources,
          mesh === null ? undefined : meshReceipt(packet.mesh!, mesh),
        ),
      });
    } catch {
      if (validated.createdArena) this.#releaseArena(arena);
      if (mesh !== null && !mesh.skipped && mesh.createdArena && mesh.arena !== null) {
        this.#releaseArena(mesh.arena);
      }
      return frozenResult('submission-failed');
    }
  }

  public dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
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
    if (this.#clipBuffer !== undefined) {
      const clipBuffer = this.#clipBuffer;
      release(() => clipBuffer.buffer.destroy());
      release(() => this.#resources.release(clipBuffer.id));
    }
    this.#clipBuffer = undefined;
    release(() => this.#pipelineCache.dispose());
    release(() => this.#vertexBuffer.destroy());
    release(() => this.#indexBuffer.destroy());
    for (const id of this.#staticResourceIds) release(() => this.#resources.release(id));
    if (firstError !== undefined) throw asError(firstError, 'Primitive scene disposal failed.');
  }

  /**
   * P4 contract, U3: checks the clip part against the draws that will be encoded and packs the
   * records. A draw's clip state must name a record of the part; a part without a clipped draw
   * is checked and writes nothing. Mask levels are refused until U4.
   */
  #preflightClip(packet: PrimitivePacket, meshDraws: readonly MeshFillDraw[]): ValidatedClip {
    const used = new Set<number>();
    for (const draw of [...packet.draws, ...meshDraws]) {
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
      return null;
    }
    if (
      part.layoutVersion !== 0 ||
      !isArrayValue(part.states) ||
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
    const states = new Map<number, Uint8Array>();
    for (const record of records.values()) {
      const bytes = packClipState(record, part.origin);
      if (bytes === null) throw new Error('Unsupported clip state record.');
      states.set(record.index, bytes);
    }
    if (this.#clip === null || used.size === 0) return null;
    const stride = this.#clipStride();
    const current = this.#clipBuffer;
    const createdBuffer = current === undefined || current.capacity < part.maxIndex;
    const buffer = createdBuffer
      ? this.#createClipBuffer(nextPowerOfTwo(part.maxIndex), stride)
      : current;
    return Object.freeze({
      buffer,
      createdBuffer,
      stride,
      frame: new Uint8Array(frame.buffer),
      states,
    });
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
        ],
      });
    } catch (error) {
      buffer.destroy();
      this.#resources.release(id);
      throw new AllocationError(error);
    }
    return { id, buffer, bindGroup, capacity, written: new Map(), frame: null };
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
        previous.buffer.destroy();
        this.#resources.release(previous.id);
      }
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
    let expectedFirst = 0;
    for (const draw of packet.draws) {
      if (
        draw.variant !== 'analytic-v1' ||
        !Number.isSafeInteger(draw.first) ||
        !Number.isSafeInteger(draw.count) ||
        draw.first !== expectedFirst ||
        draw.count <= 0
      ) {
        throw new TypeError('Invalid primitive draw range.');
      }
      expectedFirst += draw.count;
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
  #preflightMesh(part: MeshPacketPart, analyticDraws: number): ValidatedMesh {
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
      if (part.writes.length !== 0 || part.draws.length !== 0) {
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
    const writeRecords = new Map<MeshResourceId, PrimitiveRecordVersion[]>(
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
        !isArrayValue(write.records) ||
        write.records.length !== write.bytes.byteLength / stride
      ) {
        throw new TypeError('Mesh write records do not cover the write range.');
      }
      write.records.forEach((record, offset) => {
        if (record.index !== firstIndex + offset || typeof record.version !== 'symbol') {
          throw new TypeError('Invalid mesh record receipt.');
        }
        writeRecords.get(write.resourceId)!.push(Object.freeze({ ...record }));
      });
      if (write.resourceId === 'meshInstances') {
        const next = new Set(instances);
        for (const record of write.records) next.add(record.index);
        instances = next;
        // Word 15 of each written record, for the joint draw check below (ST-U7, section 4.5).
        const view = new DataView(
          write.bytes.buffer,
          write.bytes.byteOffset,
          write.bytes.byteLength,
        );
        const nextLinks = new Map(links);
        write.records.forEach((record, offset) => {
          nextLinks.set(record.index, view.getUint32(offset * stride + 60, true));
        });
        links = nextLinks;
      } else if (write.resourceId === 'meshFrame') {
        frameInitialized = true;
      }
    }

    const instanceCapacity = capacities.meshInstances / MESH_RESOURCE_STRIDES.meshInstances;
    const triangleCapacity = capacities.meshTriangles / MESH_RESOURCE_STRIDES.meshTriangles;
    let previousPosition = 0;
    for (const draw of part.draws) {
      if (
        typeof draw !== 'object' ||
        draw === null ||
        !Number.isSafeInteger(draw.position) ||
        draw.position < previousPosition ||
        draw.position > analyticDraws ||
        !Number.isSafeInteger(draw.instance) ||
        draw.instance < 0 ||
        draw.instance >= instanceCapacity ||
        !instances.has(draw.instance) ||
        !Number.isSafeInteger(draw.firstTriangle) ||
        draw.firstTriangle < 0 ||
        !Number.isSafeInteger(draw.triangleCount) ||
        draw.triangleCount <= 0 ||
        draw.firstTriangle + draw.triangleCount > triangleCapacity ||
        (draw.composite !== undefined && draw.composite !== 'joint-fill')
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
      }
      previousPosition = draw.position;
    }
    if (part.draws.length > 0 && !frameInitialized) {
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

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return (
    left.byteLength === right.byteLength && left.every((value, index) => value === right[index])
  );
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
          mesh = Object.freeze({
            pipeline: meshPipeline,
            jointPipeline,
            resetPipeline,
            resetShader,
            bindGroupLayout: meshBindGroupLayout,
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
        let meshClip: GPURenderPipeline | null = null;
        let meshJointClip: GPURenderPipeline | null = null;
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
          const meshVariant = (kind: 'fill' | 'joint') =>
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
        }
        clip = Object.freeze({
          bindGroupLayout: clipBindGroupLayout,
          analytic,
          mesh: meshClip,
          meshJoint: meshJointClip,
        });
      } catch {
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
  if (sampleCount === 1) return Object.freeze({ fill, joint, reset, readout: null });
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
  return Object.freeze({ fill, joint, reset, readout: Object.freeze({ pipeline, layout }) });
}
