import {
  ABI_VERSION,
  AbiContractError,
  BATCH_STATUS,
  MAX_U32,
  OUTPUT_CAP_BYTES,
  assertKernelExports,
  assertMemoryRange,
  batchErrorCode,
  decodeOutput,
  isU32,
  packInput,
  readKernelWork,
  validatePackedInputSize,
  type DecodedPath,
  type PackedPath,
} from './abi.js';
import type {
  GeometryBatchErrorCode,
  GeometryBatchResult,
  GeometryBounds,
  GeometryCacheOptions,
  GeometryFillRule,
  GeometryKernelExports,
  GeometryKernelWork,
  GeometryPathErrorCode,
  GeometryPathErrorResult,
  GeometryRequest,
  GeometryResult,
  GeometrySessionOptions,
  GeometrySessionStatistics,
  GeometrySuccessResult,
} from './types.js';

const DEFAULT_MAX_VARIANTS = 10_000;
const DEFAULT_MAX_NODES = 10_000;
const DEFAULT_MAX_PAYLOAD_BYTES = 16 * 1024 * 1024;
const ZERO_WORK: GeometryKernelWork = {
  logicalCubics: 0n,
  sizingVisits: 0n,
  emissionVisits: 0n,
  emittedCubicLines: 0n,
  attemptedPaths: 0n,
  failedPaths: 0n,
};
const EMPTY_MEMORY_STATE: MemoryState = {
  buffer: new ArrayBuffer(0),
  byteLength: 0,
  epoch: 0,
  inputPointer: 0,
  inputCapacity: 0,
  outputPointer: 0,
  outputCapacity: 0,
};

interface CacheLimits {
  readonly maxVariants: number;
  readonly maxNodes: number;
  readonly maxPayloadBytes: number;
}

interface CachedVariant {
  readonly status: 'OK' | 'EMPTY';
  readonly bounds: GeometryBounds;
  readonly verbs: Uint8Array;
  readonly points: Float64Array;
  readonly provenance: Uint32Array;
  readonly payloadBytes: number;
}

interface NodeEntry {
  readonly domainId: string;
  readonly nodeId: string;
  readonly sourceEpoch: number;
  readonly sourceRevision: number;
  readonly verbs: Uint8Array;
  readonly pointBytes: Uint8Array;
  readonly inputPayloadBytes: number;
  readonly variants: Map<string, Map<GeometryFillRule, Map<number, CachedVariant>>>;
  variantCount: number;
  variantPayloadBytes: number;
}

interface PreparedMiss {
  readonly resultIndex: number;
  readonly request: GeometryRequest;
  readonly packed: PackedPath;
  readonly residentNode: NodeEntry | null;
  readonly tolerance: number;
}

interface DeferredHit {
  readonly request: GeometryRequest;
  readonly variant: CachedVariant;
}

interface MemoryState {
  readonly buffer: ArrayBuffer;
  readonly byteLength: number;
  readonly epoch: number;
  readonly inputPointer: number;
  readonly inputCapacity: number;
  readonly outputPointer: number;
  readonly outputCapacity: number;
}

class GeometryCache {
  readonly limits: CacheLimits;
  readonly domains = new Map<string, Map<string, NodeEntry>>();
  readonly lru = new Map<NodeEntry, true>();
  payloadBytes = 0;
  variantCount = 0;
  evictions = 0;

  constructor(options: GeometryCacheOptions | undefined) {
    this.limits = {
      maxVariants: cacheLimit(options?.maxVariants, DEFAULT_MAX_VARIANTS, 'maxVariants'),
      maxNodes: cacheLimit(options?.maxNodes, DEFAULT_MAX_NODES, 'maxNodes'),
      maxPayloadBytes: cacheLimit(
        options?.maxPayloadBytes,
        DEFAULT_MAX_PAYLOAD_BYTES,
        'maxPayloadBytes',
      ),
    };
  }

  get(domainId: string, nodeId: string): NodeEntry | undefined {
    return this.domains.get(domainId)?.get(nodeId);
  }

  current(entry: NodeEntry): boolean {
    return this.get(entry.domainId, entry.nodeId) === entry;
  }

  touch(entry: NodeEntry): void {
    if (!this.current(entry)) return;
    this.lru.delete(entry);
    this.lru.set(entry, true);
  }

  replace(request: GeometryRequest, verbs: Uint8Array, pointBytes: Uint8Array): NodeEntry | null {
    this.remove(request.domainId, request.nodeId, false);
    const inputPayloadBytes = verbs.byteLength + pointBytes.byteLength;
    if (
      this.limits.maxNodes === 0 ||
      inputPayloadBytes > this.limits.maxPayloadBytes ||
      inputPayloadBytes > DEFAULT_MAX_PAYLOAD_BYTES
    ) {
      return null;
    }
    const entry: NodeEntry = {
      domainId: request.domainId,
      nodeId: request.nodeId,
      sourceEpoch: request.sourceEpoch,
      sourceRevision: request.sourceRevision,
      verbs,
      pointBytes,
      inputPayloadBytes,
      variants: new Map(),
      variantCount: 0,
      variantPayloadBytes: 0,
    };
    let nodes = this.domains.get(request.domainId);
    if (nodes === undefined) {
      nodes = new Map();
      this.domains.set(request.domainId, nodes);
    }
    nodes.set(request.nodeId, entry);
    this.lru.set(entry, true);
    this.payloadBytes += inputPayloadBytes;
    this.evictUntilWithinLimits(entry);
    return this.current(entry) ? entry : null;
  }

  findVariant(
    entry: NodeEntry,
    strokeStyleHash: string,
    fillRule: GeometryFillRule,
    tolerance: number,
  ): CachedVariant | undefined {
    const variant = entry.variants.get(strokeStyleHash)?.get(fillRule)?.get(tolerance);
    if (variant !== undefined) this.touch(entry);
    return variant;
  }

  admitVariant(
    entry: NodeEntry,
    strokeStyleHash: string,
    fillRule: GeometryFillRule,
    tolerance: number,
    result: GeometrySuccessResult,
  ): void {
    if (!this.current(entry) || this.findVariant(entry, strokeStyleHash, fillRule, tolerance))
      return;
    const payloadBytes =
      result.verbs.byteLength + result.points.byteLength + result.provenance.byteLength;
    if (
      this.limits.maxVariants === 0 ||
      entry.inputPayloadBytes + entry.variantPayloadBytes + payloadBytes >
        this.limits.maxPayloadBytes
    ) {
      return;
    }
    while (
      (this.variantCount + 1 > this.limits.maxVariants ||
        this.payloadBytes + payloadBytes > this.limits.maxPayloadBytes) &&
      this.evictOldestOtherThan(entry)
    ) {
      // Whole-node eviction is repeated until this variant fits or no other node remains.
    }
    if (
      this.variantCount + 1 > this.limits.maxVariants ||
      this.payloadBytes + payloadBytes > this.limits.maxPayloadBytes ||
      !this.current(entry)
    ) {
      return;
    }
    const variant = cloneVariant(result);
    let fills = entry.variants.get(strokeStyleHash);
    if (fills === undefined) {
      fills = new Map();
      entry.variants.set(strokeStyleHash, fills);
    }
    let tolerances = fills.get(fillRule);
    if (tolerances === undefined) {
      tolerances = new Map();
      fills.set(fillRule, tolerances);
    }
    tolerances.set(tolerance, variant);
    entry.variantCount += 1;
    entry.variantPayloadBytes += variant.payloadBytes;
    this.variantCount += 1;
    this.payloadBytes += variant.payloadBytes;
    this.touch(entry);
  }

  remove(domainId: string, nodeId: string, capacityEviction: boolean): void {
    const entry = this.get(domainId, nodeId);
    if (entry === undefined) return;
    this.lru.delete(entry);
    const nodes = this.domains.get(domainId);
    nodes?.delete(nodeId);
    if (nodes?.size === 0) this.domains.delete(domainId);
    this.payloadBytes -= entry.inputPayloadBytes + entry.variantPayloadBytes;
    this.variantCount -= entry.variantCount;
    if (capacityEviction) this.evictions += 1;
  }

  clear(): void {
    this.domains.clear();
    this.lru.clear();
    this.payloadBytes = 0;
    this.variantCount = 0;
  }

  private evictUntilWithinLimits(protectedEntry: NodeEntry): void {
    while (
      (this.lru.size > this.limits.maxNodes ||
        this.variantCount > this.limits.maxVariants ||
        this.payloadBytes > this.limits.maxPayloadBytes) &&
      this.evictOldestOtherThan(protectedEntry)
    ) {
      // Keep the just-admitted fitting registry and evict older whole nodes first.
    }
    if (
      this.lru.size > this.limits.maxNodes ||
      this.variantCount > this.limits.maxVariants ||
      this.payloadBytes > this.limits.maxPayloadBytes
    ) {
      this.remove(protectedEntry.domainId, protectedEntry.nodeId, false);
    }
  }

  private evictOldestOtherThan(protectedEntry: NodeEntry): boolean {
    for (const entry of this.lru.keys()) {
      if (entry !== protectedEntry) {
        this.remove(entry.domainId, entry.nodeId, true);
        return true;
      }
    }
    return false;
  }
}

export class GeometrySession {
  private kernel: GeometryKernelExports | null;
  private memoryState: MemoryState = EMPTY_MEMORY_STATE;
  private readonly cache!: GeometryCache;
  private disposed = false;
  private hits = 0;
  private misses = 0;
  private kernelPathBuilds = 0;
  private kernelWork: GeometryKernelWork = { ...ZERO_WORK };

  constructor(kernel: GeometryKernelExports, options: GeometrySessionOptions = {}) {
    this.kernel = kernel;
    try {
      this.cache = new GeometryCache(options.cache);
      assertKernelExports(kernel);
      if (kernel.abi_version() !== ABI_VERSION) {
        throw new AbiContractError('WASM ABI version is not supported');
      }
      this.memoryState = this.readMemoryState(kernel);
    } catch (error) {
      try {
        kernel.dispose();
      } catch {
        // Initialization already failed; cleanup is best effort.
      }
      this.kernel = null;
      this.memoryState = EMPTY_MEMORY_STATE;
      this.disposed = true;
      throw error;
    }
  }

  batch(requests: readonly GeometryRequest[]): GeometryBatchResult {
    if (this.disposed || this.kernel === null)
      return batchFailure('DISPOSED', 'session is disposed');
    if (!isRuntimeArray(requests))
      return batchFailure('INVALID_REQUEST', 'requests must be an array');
    for (let index = 0; index < requests.length; index += 1) {
      if (!(index in requests))
        return batchFailure('INVALID_REQUEST', 'requests must not be sparse');
    }

    try {
      const preflight: PackedPath[] = [];
      for (let index = 0; index < requests.length; index += 1) {
        const request = requests[index]!;
        const validation = validateRequestEnvelope(request);
        if (validation !== null) return batchFailure('INVALID_REQUEST', validation);
        preflight.push({
          requestId: request.requestId,
          sourceEpoch: request.sourceEpoch,
          sourceRevision: request.sourceRevision,
          tolerance: 1,
          verbs: request.verbs,
          points: request.points,
        });
      }
      validatePackedInputSize(preflight);
    } catch (error) {
      return error instanceof RangeError
        ? batchFailure('RESOURCE_LIMIT', error.message)
        : this.failClosed(error);
    }

    let results: (GeometryResult | DeferredHit | undefined)[];
    try {
      results = new Array<GeometryResult | DeferredHit | undefined>(requests.length);
    } catch (error) {
      return error instanceof RangeError ? this.allocationFailure(error) : this.failClosed(error);
    }
    const misses: PreparedMiss[] = [];
    try {
      requests.forEach((request, resultIndex) => {
        const validation = validateRequestEnvelope(request);
        if (validation !== null) throw new RequestEnvelopeError(validation);
        const existing = this.cache.get(request.domainId, request.nodeId);
        let resident: NodeEntry | null = existing ?? null;
        if (existing !== undefined) {
          const sourceOrder = compareSource(request, existing);
          if (sourceOrder < 0) {
            results[resultIndex] = pathFailure(
              request,
              'STALE_SOURCE',
              'source pair is older than the resident node',
            );
            return;
          }
          if (sourceOrder === 0 && !sameGeometry(existing, request)) {
            results[resultIndex] = pathFailure(
              request,
              'REVISION_CONFLICT',
              'equal source tokens identify different canonical geometry',
            );
            return;
          }
          if (sourceOrder > 0) resident = this.retainRevision(request);
          else this.cache.touch(existing);
        } else {
          resident = this.retainRevision(request);
        }

        if (!isCanonicalPath(request.verbs, request.points)) {
          results[resultIndex] = pathFailure(
            request,
            'INVALID_PATH',
            'canonical path state or coordinates are invalid',
          );
          return;
        }
        const tolerance = screenTolerance(request.world, request.zoom, request.devicePixelRatio);
        if (!tolerance.ok) {
          results[resultIndex] = pathFailure(request, tolerance.status, tolerance.message);
          return;
        }
        const cached =
          resident === null
            ? undefined
            : this.cache.findVariant(
                resident,
                request.strokeStyleHash,
                request.fillRule,
                tolerance.value,
              );
        if (cached !== undefined) {
          this.hits += 1;
          results[resultIndex] = { request, variant: cached };
          return;
        }
        this.misses += 1;
        misses.push({
          resultIndex,
          request,
          residentNode: resident,
          tolerance: tolerance.value,
          packed: {
            requestId: request.requestId,
            sourceEpoch: request.sourceEpoch,
            sourceRevision: request.sourceRevision,
            tolerance: tolerance.value,
            verbs: request.verbs,
            points: request.points,
          },
        });
      });
    } catch (error) {
      if (error instanceof RequestEnvelopeError) {
        return batchFailure('INVALID_REQUEST', error.message);
      }
      if (error instanceof RangeError) return this.allocationFailure(error);
      return this.failClosed(error);
    }

    try {
      if (misses.length !== 0) {
        const computed = this.executeMisses(misses);
        if (computed.status === 'BATCH_ERROR') return computed;
        computed.results.forEach((result, index) => {
          const miss = misses[index];
          if (miss === undefined)
            throw new AbiContractError('kernel returned a surplus path result');
          results[miss.resultIndex] = result;
        });
      }

      if (results.some((result) => result === undefined)) {
        return this.failClosed(
          new AbiContractError('adapter did not publish one result per request'),
        );
      }
      if (!publishedResultsFit(results as readonly (GeometryResult | DeferredHit)[])) {
        return batchFailure('RESOURCE_LIMIT', 'batch results exceed the 256 MiB output safeguard');
      }
      for (const miss of misses) {
        const result = results[miss.resultIndex];
        if (
          result !== undefined &&
          !isDeferredHit(result) &&
          (result.status === 'OK' || result.status === 'EMPTY') &&
          miss.residentNode !== null &&
          this.cache.current(miss.residentNode) &&
          miss.residentNode.sourceEpoch === miss.request.sourceEpoch &&
          miss.residentNode.sourceRevision === miss.request.sourceRevision &&
          sameGeometry(miss.residentNode, miss.request)
        ) {
          this.cache.admitVariant(
            miss.residentNode,
            miss.request.strokeStyleHash,
            miss.request.fillRule,
            miss.tolerance,
            result,
          );
        }
      }
      return {
        status: 'OK',
        results: (results as readonly (GeometryResult | DeferredHit)[]).map((result) =>
          isDeferredHit(result) ? resultFromVariant(result.request, result.variant) : result,
        ),
      };
    } catch (error) {
      if (error instanceof RangeError) return this.allocationFailure(error);
      return this.failClosed(error);
    }
  }

  snapshotStatistics(): GeometrySessionStatistics {
    return {
      hits: this.hits,
      misses: this.misses,
      kernelPathBuilds: this.kernelPathBuilds,
      evictions: this.cache.evictions,
      retainedPayloadBytes: this.cache.payloadBytes,
      liveLinearMemoryBytes: this.kernel?.memory.buffer.byteLength ?? 0,
      residentNodes: this.cache.lru.size,
      variantEntries: this.cache.variantCount,
      kernelWork: { ...this.kernelWork },
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.cache.clear();
    const kernel = this.kernel;
    this.disposed = true;
    if (kernel !== null) {
      try {
        this.mutate(kernel, 'dispose', true, () => kernel.dispose());
      } catch {
        // Disposal is terminal even if an already-broken kernel cannot acknowledge it.
      }
    }
    this.kernel = null;
    this.memoryState = EMPTY_MEMORY_STATE;
  }

  private retainRevision(request: GeometryRequest): NodeEntry | null {
    const inputBytes = request.verbs.byteLength + request.points.byteLength;
    if (inputBytes > this.cache.limits.maxPayloadBytes) {
      this.cache.remove(request.domainId, request.nodeId, false);
      return null;
    }
    return this.cache.replace(
      request,
      request.verbs.slice(),
      new Uint8Array(
        request.points.buffer.slice(
          request.points.byteOffset,
          request.points.byteOffset + request.points.byteLength,
        ),
      ),
    );
  }

  private executeMisses(misses: readonly PreparedMiss[]): GeometryBatchResult {
    const kernel = this.kernel;
    if (kernel === null) return batchFailure('DISPOSED', 'session is disposed');
    let input: Uint8Array;
    try {
      validatePackedInputSize(misses.map((miss) => miss.packed));
    } catch (error) {
      return error instanceof RangeError
        ? batchFailure('RESOURCE_LIMIT', error.message)
        : this.failClosed(error);
    }
    try {
      input = packInput(misses.map((miss) => miss.packed));
    } catch (error) {
      return error instanceof RangeError ? this.allocationFailure(error) : this.failClosed(error);
    }

    try {
      if (input.byteLength > this.memoryState.inputCapacity) {
        const reserveStatus = this.mutate(kernel, 'reserve', true, () =>
          kernel.reserve(input.byteLength, this.memoryState.outputCapacity),
        );
        if (reserveStatus !== BATCH_STATUS.OK)
          return this.handleBatchStatus(reserveStatus, 'reserve');
      }
      this.copyInput(input);

      let processStatus = this.process(kernel, input.byteLength, misses.length);
      if (processStatus === BATCH_STATUS.OUTPUT_CAPACITY) {
        if (kernel.result_len() !== 0) {
          throw new AbiContractError('capacity failure published a readable result');
        }
        const required = kernel.required_output_bytes();
        if (!isU32(required) || required === 0 || required <= this.memoryState.outputCapacity) {
          throw new AbiContractError('capacity failure did not report a larger exact requirement');
        }
        const retryReserve = this.mutate(kernel, 'reserve', true, () =>
          kernel.reserve(input.byteLength, required),
        );
        if (retryReserve !== BATCH_STATUS.OK)
          return this.handleBatchStatus(retryReserve, 'retry reserve');
        if (this.memoryState.outputCapacity < required) {
          throw new AbiContractError('retry reserve did not provide the requested output capacity');
        }
        this.copyInput(input);
        processStatus = this.process(kernel, input.byteLength, misses.length);
        if (processStatus === BATCH_STATUS.OUTPUT_CAPACITY) {
          throw new AbiContractError('exact output-capacity retry was insufficient');
        }
      }
      if (processStatus !== BATCH_STATUS.OK)
        return this.handleBatchStatus(processStatus, 'process');
      const resultLength = kernel.result_len();
      if (
        !isU32(resultLength) ||
        resultLength === 0 ||
        resultLength > this.memoryState.outputCapacity
      ) {
        throw new AbiContractError('successful process published an invalid result length');
      }
      assertMemoryRange(
        this.memoryState.byteLength,
        this.memoryState.outputPointer,
        resultLength,
        'output',
      );
      const borrowed = new Uint8Array(
        this.memoryState.buffer,
        this.memoryState.outputPointer,
        resultLength,
      );
      const decoded: readonly DecodedPath[] = decodeOutput(
        borrowed,
        misses.map((miss) => miss.packed),
      );
      return { status: 'OK', results: decoded.map(decodedResult) };
    } catch (error) {
      return error instanceof RangeError ? this.allocationFailure(error) : this.failClosed(error);
    }
  }

  private process(kernel: GeometryKernelExports, inputLength: number, pathCount: number): number {
    const status = this.mutate(kernel, 'process', false, () => kernel.process(inputLength));
    this.kernelPathBuilds += pathCount;
    const pointer = kernel.statistics_ptr();
    if (!isU32(pointer)) throw new AbiContractError('statistics pointer is not u32');
    const work = readKernelWork(kernel.memory, pointer);
    this.kernelWork = addWork(this.kernelWork, work);
    return status;
  }

  private copyInput(input: Uint8Array): void {
    assertMemoryRange(
      this.memoryState.byteLength,
      this.memoryState.inputPointer,
      input.byteLength,
      'input',
    );
    if (input.byteLength > this.memoryState.inputCapacity) {
      throw new AbiContractError('reserved input capacity is smaller than packed input');
    }
    new Uint8Array(this.memoryState.buffer, this.memoryState.inputPointer, input.byteLength).set(
      input,
    );
  }

  private mutate(
    kernel: GeometryKernelExports,
    operation: string,
    allowMemoryChange: boolean,
    call: () => number,
  ): number {
    const before = this.memoryState;
    if (before.epoch === MAX_U32) throw new AbiContractError('linear-memory epoch is exhausted');
    const status = call();
    if (!isU32(status)) throw new AbiContractError(`${operation} returned a non-u32 status`);
    const after = this.readMemoryState(kernel);
    if (after.epoch !== before.epoch + 1) {
      throw new AbiContractError(`${operation} did not advance memory epoch exactly once`);
    }
    if (
      !allowMemoryChange &&
      (after.buffer !== before.buffer ||
        after.byteLength !== before.byteLength ||
        after.inputPointer !== before.inputPointer ||
        after.inputCapacity !== before.inputCapacity ||
        after.outputPointer !== before.outputPointer ||
        after.outputCapacity !== before.outputCapacity)
    ) {
      throw new AbiContractError(`${operation} unexpectedly changed linear-memory storage`);
    }
    this.memoryState = after;
    return status;
  }

  private readMemoryState(kernel: GeometryKernelExports): MemoryState {
    const buffer = kernel.memory.buffer;
    if (!(buffer instanceof ArrayBuffer))
      throw new AbiContractError('shared linear memory is unsupported');
    const state: MemoryState = {
      buffer,
      byteLength: buffer.byteLength,
      epoch: kernel.memory_epoch(),
      inputPointer: kernel.input_ptr(),
      inputCapacity: kernel.input_capacity(),
      outputPointer: kernel.output_ptr(),
      outputCapacity: kernel.output_capacity(),
    };
    for (const [name, value] of Object.entries(state)) {
      if (name !== 'buffer' && !isU32(value as number)) {
        throw new AbiContractError(`${name} is not u32`);
      }
    }
    assertMemoryRange(state.byteLength, state.inputPointer, state.inputCapacity, 'input capacity');
    assertMemoryRange(
      state.byteLength,
      state.outputPointer,
      state.outputCapacity,
      'output capacity',
    );
    if (state.inputCapacity > 64 * 1024 * 1024 || state.outputCapacity > OUTPUT_CAP_BYTES) {
      throw new AbiContractError('arena capacity exceeds the frozen resource caps');
    }
    if (
      state.inputCapacity > 0 &&
      state.outputCapacity > 0 &&
      rangesOverlap(
        state.inputPointer,
        state.inputCapacity,
        state.outputPointer,
        state.outputCapacity,
      )
    ) {
      throw new AbiContractError('input and output arenas overlap');
    }
    if (state.inputPointer % 8 !== 0 || state.outputPointer % 8 !== 0) {
      throw new AbiContractError('arena pointer is not 8-byte aligned');
    }
    return state;
  }

  private handleBatchStatus(status: number, operation: string): GeometryBatchResult {
    if (status === BATCH_STATUS.OUTPUT_CAPACITY) {
      return this.failClosed(
        new AbiContractError(`${operation} returned unexpected OUTPUT_CAPACITY`),
      );
    }
    const code = batchErrorCode(status);
    if (code === null)
      return this.failClosed(new AbiContractError(`${operation} returned unknown status`));
    const kernel = this.kernel;
    if (kernel === null) return batchFailure('DISPOSED', 'session is disposed');
    if (kernel.result_len() !== 0) {
      return this.failClosed(new AbiContractError(`${operation} failure published a result`));
    }
    if (status === BATCH_STATUS.RESOURCE_LIMIT && kernel.required_output_bytes() !== 0) {
      return this.failClosed(
        new AbiContractError(`${operation} RESOURCE_LIMIT published an output requirement`),
      );
    }
    if (status === BATCH_STATUS.DISPOSED) {
      this.cache.clear();
      this.disposed = true;
      this.kernel = null;
      this.memoryState = EMPTY_MEMORY_STATE;
      return batchFailure('DISPOSED', `${operation} found a disposed kernel`);
    }
    if (status === BATCH_STATUS.INVALID_BATCH || status === BATCH_STATUS.INTERNAL_ERROR) {
      return this.failClosed(new AbiContractError(`${operation} failed with ${code}`));
    }
    return batchFailure(code, `${operation} failed with ${code}`);
  }

  private allocationFailure(error: RangeError): GeometryBatchResult {
    this.cache.clear();
    return batchFailure('ALLOCATION_FAILED', error.message);
  }

  private failClosed(error: unknown): GeometryBatchResult {
    const code: GeometryBatchErrorCode =
      error instanceof AbiContractError ? 'ABI_CONTRACT' : 'WASM_TRAP';
    const message = error instanceof Error ? error.message : String(error);
    this.cache.clear();
    const kernel = this.kernel;
    this.disposed = true;
    if (kernel !== null) {
      try {
        this.mutate(kernel, 'dispose', true, () => kernel.dispose());
      } catch {
        // The contract is already breached and host-owned state has been released.
      }
    }
    this.kernel = null;
    this.memoryState = EMPTY_MEMORY_STATE;
    return batchFailure(code, message);
  }
}

export async function createGeometrySession(
  source: WebAssembly.Module | BufferSource,
  options: GeometrySessionOptions = {},
): Promise<GeometrySession> {
  let instance: WebAssembly.Instance;
  if (source instanceof WebAssembly.Module) {
    instance = await WebAssembly.instantiate(source, {});
  } else {
    const instantiated = await WebAssembly.instantiate(source, {});
    instance = instantiated.instance;
  }
  return new GeometrySession(instance.exports as unknown as GeometryKernelExports, options);
}

function cacheLimit(value: number | undefined, maximum: number, name: string): number {
  const resolved = value ?? maximum;
  if (!Number.isInteger(resolved) || resolved < 0 || resolved > maximum) {
    throw new RangeError(`${name} must be an integer from 0 through ${String(maximum)}`);
  }
  return resolved;
}

function isRuntimeArray(value: unknown): boolean {
  return Array.isArray(value);
}

function validateRequestEnvelope(request: GeometryRequest): string | null {
  if (typeof request !== 'object' || request === null) return 'request must be an object';
  if (typeof request.domainId !== 'string' || typeof request.nodeId !== 'string') {
    return 'domainId and nodeId must be opaque strings';
  }
  if (typeof request.strokeStyleHash !== 'string')
    return 'strokeStyleHash must be an opaque string';
  if (request.fillRule !== 'nonzero' && request.fillRule !== 'evenodd')
    return 'fillRule is invalid';
  if (!isU32(request.requestId) || !isU32(request.sourceEpoch) || !isU32(request.sourceRevision)) {
    return 'request and source tokens must be u32 values';
  }
  if (!(request.verbs instanceof Uint8Array) || !(request.points instanceof Float64Array)) {
    return 'verbs and points must use the declared typed arrays';
  }
  if (
    !(request.verbs.buffer instanceof ArrayBuffer) ||
    !(request.points.buffer instanceof ArrayBuffer)
  ) {
    return 'shared request buffers violate the single-threaded ABI';
  }
  if (!Array.isArray(request.world) || request.world.length !== 4)
    return 'world must be a 2x2 tuple';
  return null;
}

function compareSource(request: GeometryRequest, entry: NodeEntry): number {
  if (request.sourceEpoch !== entry.sourceEpoch)
    return request.sourceEpoch < entry.sourceEpoch ? -1 : 1;
  if (request.sourceRevision === entry.sourceRevision) return 0;
  return request.sourceRevision < entry.sourceRevision ? -1 : 1;
}

function sameGeometry(entry: NodeEntry, request: GeometryRequest): boolean {
  if (
    entry.verbs.length !== request.verbs.length ||
    entry.pointBytes.length !== request.points.byteLength
  ) {
    return false;
  }
  for (let index = 0; index < entry.verbs.length; index += 1) {
    if (entry.verbs[index] !== request.verbs[index]) return false;
  }
  const requestBytes = new Uint8Array(
    request.points.buffer,
    request.points.byteOffset,
    request.points.byteLength,
  );
  for (let index = 0; index < entry.pointBytes.length; index += 1) {
    if (entry.pointBytes[index] !== requestBytes[index]) return false;
  }
  return true;
}

function isCanonicalPath(verbs: Uint8Array, points: Float64Array): boolean {
  let pointIndex = 0;
  let open = false;
  for (const verb of verbs) {
    let arity: number;
    if (verb === 0) {
      open = true;
      arity = 2;
    } else if (verb === 1) {
      if (!open) return false;
      arity = 2;
    } else if (verb === 2) {
      if (!open) return false;
      arity = 6;
    } else if (verb === 3) {
      if (!open) return false;
      open = false;
      arity = 0;
    } else {
      return false;
    }
    const end = pointIndex + arity;
    if (end > points.length) return false;
    for (; pointIndex < end; pointIndex += 1) {
      if (!Number.isFinite(points[pointIndex])) return false;
    }
  }
  return pointIndex === points.length;
}

function screenTolerance(
  world: readonly [number, number, number, number],
  zoom: number,
  devicePixelRatio: number,
):
  | { readonly ok: true; readonly value: number }
  | {
      readonly ok: false;
      readonly status: 'INVALID_TOLERANCE' | 'NUMERIC_RANGE';
      readonly message: string;
    } {
  if (
    !Number.isFinite(zoom) ||
    !Number.isFinite(devicePixelRatio) ||
    zoom <= 0 ||
    devicePixelRatio <= 0
  ) {
    return {
      ok: false,
      status: 'INVALID_TOLERANCE',
      message: 'zoom and DPR must be finite and positive',
    };
  }
  if (!world.every(Number.isFinite)) {
    return { ok: false, status: 'NUMERIC_RANGE', message: 'world matrix must be finite' };
  }
  const factor = zoom * devicePixelRatio;
  if (!Number.isFinite(factor) || factor === 0) {
    return { ok: false, status: 'NUMERIC_RANGE', message: 'zoom/DPR product is unrepresentable' };
  }
  const scaled = world.map((value) => value * factor);
  if (!scaled.every(Number.isFinite)) {
    return { ok: false, status: 'NUMERIC_RANGE', message: 'physical screen matrix is nonfinite' };
  }
  const scale = Math.max(...scaled.map(Math.abs));
  const worldIsZero = world.every((value) => value === 0);
  if (scale === 0) {
    return worldIsZero
      ? { ok: true, value: 1 }
      : { ok: false, status: 'NUMERIC_RANGE', message: 'physical screen matrix underflowed' };
  }
  const a = scaled[0]! / scale;
  const b = scaled[1]! / scale;
  const c = scaled[2]! / scale;
  const d = scaled[3]! / scale;
  const normalized = (Math.hypot(a + d, c - b) + Math.hypot(a - d, c + b)) / 2;
  const sigma = scale * normalized;
  if (!Number.isFinite(sigma) || sigma <= 0) {
    return {
      ok: false,
      status: 'NUMERIC_RANGE',
      message: 'largest singular value is unrepresentable',
    };
  }
  const required = 0.25 / sigma;
  if (!Number.isFinite(required) || required <= 0) {
    return { ok: false, status: 'NUMERIC_RANGE', message: 'local tolerance is unrepresentable' };
  }
  let bucket = 2 ** Math.min(1023, Math.floor(Math.log2(required)));
  if (!Number.isFinite(bucket) || bucket <= 0) {
    return { ok: false, status: 'NUMERIC_RANGE', message: 'tolerance bucket is unrepresentable' };
  }
  while (bucket > required) bucket /= 2;
  while (Number.isFinite(bucket * 2) && bucket * 2 <= required) bucket *= 2;
  if (bucket <= 0 || bucket > required) {
    return { ok: false, status: 'NUMERIC_RANGE', message: 'tolerance bucket comparison failed' };
  }
  return { ok: true, value: bucket };
}

function cloneVariant(result: GeometrySuccessResult): CachedVariant {
  const verbs = result.verbs.slice();
  const points = result.points.slice();
  const provenance = result.provenance.slice();
  return {
    status: result.status,
    bounds: { ...result.bounds },
    verbs,
    points,
    provenance,
    payloadBytes: verbs.byteLength + points.byteLength + provenance.byteLength,
  };
}

function resultFromVariant(
  request: GeometryRequest,
  variant: CachedVariant,
): GeometrySuccessResult {
  return {
    requestId: request.requestId,
    sourceEpoch: request.sourceEpoch,
    sourceRevision: request.sourceRevision,
    status: variant.status,
    bounds: { ...variant.bounds },
    verbs: variant.verbs.slice(),
    points: variant.points.slice(),
    provenance: variant.provenance.slice(),
  };
}

function isDeferredHit(result: GeometryResult | DeferredHit): result is DeferredHit {
  return 'variant' in result;
}

function publishedResultsFit(results: readonly (GeometryResult | DeferredHit)[]): boolean {
  let verbCount = 0;
  let pointBytes = 0;
  for (const result of results) {
    const success = isDeferredHit(result)
      ? result.variant
      : result.status === 'OK' || result.status === 'EMPTY'
        ? result
        : null;
    if (success === null) continue;
    verbCount += success.verbs.length;
    pointBytes += success.points.byteLength;
    if (!Number.isSafeInteger(verbCount) || !Number.isSafeInteger(pointBytes)) return false;
  }
  const resultBytes = results.length * 64;
  const pointsOffset = alignNumber(48 + resultBytes + verbCount, 8);
  const provenanceOffset = alignNumber(pointsOffset + pointBytes, 4);
  const total = provenanceOffset + verbCount * 12;
  return Number.isSafeInteger(total) && total <= OUTPUT_CAP_BYTES;
}

function alignNumber(value: number, alignment: number): number {
  return Math.ceil(value / alignment) * alignment;
}

function rangesOverlap(
  firstStart: number,
  firstLength: number,
  secondStart: number,
  secondLength: number,
): boolean {
  return firstStart < secondStart + secondLength && secondStart < firstStart + firstLength;
}

function decodedResult(result: DecodedPath): GeometryResult {
  if (result.status !== 'OK' && result.status !== 'EMPTY') {
    return {
      requestId: result.requestId,
      sourceEpoch: result.sourceEpoch,
      sourceRevision: result.sourceRevision,
      status: result.status,
      error: { code: result.status, message: `kernel path failed with ${result.status}` },
    };
  }
  return {
    requestId: result.requestId,
    sourceEpoch: result.sourceEpoch,
    sourceRevision: result.sourceRevision,
    status: result.status,
    bounds: { ...result.bounds },
    verbs: result.verbs,
    points: result.points,
    provenance: result.provenance,
  };
}

function pathFailure(
  request: Pick<GeometryRequest, 'requestId' | 'sourceEpoch' | 'sourceRevision'>,
  code: GeometryPathErrorCode,
  message: string,
): GeometryPathErrorResult {
  return {
    requestId: request.requestId,
    sourceEpoch: request.sourceEpoch,
    sourceRevision: request.sourceRevision,
    status: code,
    error: { code, message },
  };
}

function batchFailure(code: GeometryBatchErrorCode, message: string): GeometryBatchResult {
  return { status: 'BATCH_ERROR', error: { code, message } };
}

function addWork(left: GeometryKernelWork, right: GeometryKernelWork): GeometryKernelWork {
  return {
    logicalCubics: left.logicalCubics + right.logicalCubics,
    sizingVisits: left.sizingVisits + right.sizingVisits,
    emissionVisits: left.emissionVisits + right.emissionVisits,
    emittedCubicLines: left.emittedCubicLines + right.emittedCubicLines,
    attemptedPaths: left.attemptedPaths + right.attemptedPaths,
    failedPaths: left.failedPaths + right.failedPaths,
  };
}

class RequestEnvelopeError extends Error {}
