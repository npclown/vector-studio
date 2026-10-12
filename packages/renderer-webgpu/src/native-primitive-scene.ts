import type { ResourceDescriptor } from '@vector-studio/contracts';
import type {
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

import { MESH_FILL_SHADER } from './mesh-fill-shader.js';
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
  meshPipelineKey,
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
} from './webgpu-platform.js';

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
  frameInitialized: boolean;
}

/** The mesh pipeline created at initialization or recovery; null when unavailable. */
interface MeshPipelineState {
  readonly pipeline: GPURenderPipeline;
  readonly bindGroupLayout: GPUBindGroupLayout;
}

type ValidatedMesh =
  | Readonly<{ skipped: true }>
  | Readonly<{
      skipped: false;
      /** Null for a part that carries notices only. */
      arena: MeshArenaState | null;
      createdArena: boolean;
      instances: ReadonlySet<number>;
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
  #currentArena: ArenaState | undefined;
  readonly #mesh: MeshPipelineState | null;
  #currentMeshArena: MeshArenaState | undefined;
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
  ) {
    this.#mesh = mesh;
    this.meshPipelineAvailable = mesh !== null;
    this.shaderModulesCreated = 1 + meshShaderModulesCreated;
    this.pipelinesCreated = mesh === null ? 1 : 2;
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
    if (this.sampleCount === 1 || target.width === 0 || target.height === 0) {
      this.#releaseAttachment();
      this.#target = copyTarget(target);
      return;
    }
    const id = `primitive/${this.#generation}/attachment-${target.surfaceRevision}`;
    const attachment = this.#device.createTexture({
      label: id,
      size: { width: target.width, height: target.height },
      sampleCount: this.sampleCount,
      format: this.#format,
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
        bytesPerTexel: 4,
      });
    } catch (error) {
      attachment.destroy();
      throw asError(error, 'Primitive attachment accounting failed.');
    }
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

  public submitPrimitivePacket(packet: PrimitivePacket): PrimitiveSubmitResult {
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
    try {
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
      const presentationView = this.#context.native.getCurrentTexture().createView();
      const multisampleView = this.#attachment?.createView();
      const encoder = this.#device.createCommandEncoder({ label: 'vector-studio/primitive-frame' });
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
      });
      const bindAnalytic = () => {
        pass.setPipeline(this.#pipeline);
        pass.setBindGroup(0, arena.bindGroup);
        pass.setVertexBuffer(0, this.#vertexBuffer, 0, 32);
        pass.setIndexBuffer(this.#indexBuffer, 'uint16', 0, 12);
      };
      bindAnalytic();
      // P3 V3 section g: draws are encoded in merged paint order; the pipeline and bind group
      // switch only at a variant change.
      let analyticBound = true;
      let nextMeshDraw = 0;
      const drawMeshesAt = (position: number) => {
        while (meshDraws[nextMeshDraw]?.position === position) {
          const draw = meshDraws[nextMeshDraw]!;
          if (analyticBound) {
            pass.setPipeline(this.#mesh!.pipeline);
            pass.setBindGroup(0, meshArena!.bindGroup);
            analyticBound = false;
          }
          pass.draw(3 * draw.triangleCount, 1, 3 * draw.firstTriangle, draw.instance);
          nextMeshDraw += 1;
        }
      };
      packet.draws.forEach((draw, index) => {
        drawMeshesAt(index);
        if (!analyticBound) {
          bindAnalytic();
          analyticBound = true;
        }
        pass.drawIndexed(6, draw.count, 0, 0, draw.first);
      });
      drawMeshesAt(packet.draws.length);
      pass.end();
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
    release(() => this.#pipelineCache.dispose());
    release(() => this.#vertexBuffer.destroy());
    release(() => this.#indexBuffer.destroy());
    for (const id of this.#staticResourceIds) release(() => this.#resources.release(id));
    if (firstError !== undefined) throw asError(firstError, 'Primitive scene disposal failed.');
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
        draw.firstTriangle + draw.triangleCount > triangleCapacity
      ) {
        throw new TypeError('Invalid mesh draw.');
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

  #releaseAttachment(): void {
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
    const createPipeline = (sampleCount: 1 | 4) =>
      pipelineCache!.getOrCreate(primitivePipelineKey(format, sampleCount), () =>
        device.createRenderPipelineAsync(
          createPrimitivePipelineDescriptor(shader, pipelineLayout, format, sampleCount),
        ),
      );
    let pipeline: GPURenderPipeline;
    let sampleCount: 1 | 4 = 4;
    let fellBackFrom4x = false;
    try {
      pipeline = await createPipeline(4);
    } catch (error) {
      if (disposed) throw asError(error, '4x pipeline creation failed after disposal.');
      sampleCount = 1;
      fellBackFrom4x = true;
      pipeline = await createPipeline(1);
    }
    if (disposed) throw new Error('Primitive scene creation completed after disposal.');
    track(`${prefix}/pipeline`, { category: 'render-pipeline' });
    // P3 V3 section f: the mesh pipeline is created here, at initialization and at each
    // recovery, next to the P1 pipeline, and never on the frame path.
    let mesh: MeshPipelineState | null = null;
    let meshShaderModulesCreated = 0;
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
          mesh = Object.freeze({ pipeline: meshPipeline, bindGroupLayout: meshBindGroupLayout });
        } catch {
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
        }
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
