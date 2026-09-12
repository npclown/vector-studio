import type { ResourceDescriptor } from '@vector-studio/contracts';
import type {
  PrimitivePacket,
  PrimitiveReceipt,
  PrimitiveRecordVersion,
  PrimitiveResourceId,
  PrimitiveSubmitResult,
  PrimitiveTarget,
} from '@vector-studio/renderer-core';

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

interface ArenaState {
  readonly id: string;
  readonly bindGroupId: string;
  readonly buffer: GPUBuffer;
  readonly bindGroup: GPUBindGroup;
  readonly allocator: SharedBufferAllocator;
  readonly allocations: Readonly<Record<PrimitiveResourceId, SharedBufferAllocation>>;
  readonly incarnations: Readonly<Record<PrimitiveResourceId, symbol>>;
  readonly capacities: Readonly<Record<PrimitiveResourceId, number>>;
  initialized: Readonly<Record<'transforms' | 'geometry' | 'styles', ReadonlySet<number>>>;
  order: ReadonlyMap<number, number>;
  frameInitialized: boolean;
  sceneEpoch: symbol | null;
  lastSubmittedSerial: number;
  retired: boolean;
  released: boolean;
}

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
  readonly shaderModulesCreated = 1;
  readonly pipelinesCreated = 1;
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
  #retiredArenas: ArenaState[] = [];
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
  ) {
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
      pass.setPipeline(this.#pipeline);
      pass.setBindGroup(0, arena.bindGroup);
      pass.setVertexBuffer(0, this.#vertexBuffer, 0, 32);
      pass.setIndexBuffer(this.#indexBuffer, 'uint16', 0, 12);
      for (const draw of packet.draws) {
        pass.drawIndexed(6, draw.count, 0, 0, draw.first);
      }
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
      this.#latestSubmittedSerial = serial;
      this.#commitPacket(packet, validated);
      this.#observeCompletion();
      return Object.freeze({
        status: 'submitted',
        receipt: createReceipt(packet, serial, validated.receiptResources),
      });
    } catch {
      if (validated.createdArena) this.#releaseArena(arena);
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
    const alignment = this.#requiredAlignment();
    let end = 0;
    for (const id of RESOURCE_ORDER) {
      end = align(end, alignment) + align(capacities[id], alignment);
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

  #retireArena(arena: ArenaState): void {
    if (arena.released || arena.retired) return;
    arena.retired = true;
    for (const id of RESOURCE_ORDER) arena.allocator.free(arena.allocations[id]);
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
        const arenas = [this.#currentArena, ...this.#retiredArenas].filter(
          (arena): arena is ArenaState => arena !== undefined,
        );
        for (const arena of arenas) {
          const completed = Math.min(observedSerial, arena.lastSubmittedSerial);
          if (completed > 0) arena.allocator.completeThrough(this.#generation, completed);
        }
        const retained: ArenaState[] = [];
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

  #releaseArena(arena: ArenaState): void {
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

function createReceipt(
  packet: PrimitivePacket,
  submissionSerial: number,
  resources: PrimitiveReceipt['resources'],
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
  });
}

export function createNativePrimitiveSceneCreation(
  device: GPUDevice,
  context: WebGpuCanvasContextPort,
  format: PrimitiveTargetFormat,
  generation: number,
  resources: WebGpuResourceTracker,
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
    if (disposed || vertexBuffer === undefined || indexBuffer === undefined) {
      throw new Error('Primitive scene creation completed after disposal.');
    }
    track(`${prefix}/pipeline`, { category: 'render-pipeline' });
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
