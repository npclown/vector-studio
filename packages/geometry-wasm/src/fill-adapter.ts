import type {
  FillMesh,
  FillMeshBatchResult,
  FillMeshFailureCode,
  FillMeshPort,
  FillMeshRequest,
  FillMeshResult,
} from '@vector-studio/contracts';

// P3 D8 V2 fill-mesh transport v0 adapter
// (docs/plans/p3-v2-fill-mesh-transport-contract.md, sections a, b, g and h).

export const FILL_V0_OPERATION_ID = 'geometry-wasm/fill-v0';
export const FILL_V0_VERSION = 0;
/** The kernel revision this adapter was built for. */
export const FILL_V0_REVISION = 1;

const INPUT_MAGIC = 0x3046_4756;
const OUTPUT_MAGIC = 0x304d_4756;
const INPUT_HEADER_BYTES = 48;
const REQUEST_BYTES = 16;
const OUTPUT_HEADER_BYTES = 64;
const RESULT_BYTES = 80;
const INPUT_CAP_BYTES = 64 * 1024 * 1024;
const OUTPUT_CAP_BYTES = 256 * 1024 * 1024;
const MAX_U32 = 0xffff_ffff;
const I32_MIN = -0x8000_0000;
const I32_MAX = 0x7fff_ffff;

const BATCH = {
  OK: 0,
  INVALID_BATCH: 1,
  OUTPUT_CAPACITY: 2,
  ALLOCATION_FAILED: 3,
  DISPOSED: 4,
  RESOURCE_LIMIT: 5,
  INTERNAL_ERROR: 6,
} as const;

const PATH_OK = 0;
const PATH_EMPTY = 1;
const PATH_FAILURES: readonly (FillMeshFailureCode | null)[] = [
  null,
  null,
  'invalid-path',
  'invalid-tolerance',
  'numeric-range',
  'work-limit',
  'unsupported-geometry',
];

/** The `fill_v0_*` export family of the geometry kernel. */
export interface FillKernelExports {
  readonly memory: WebAssembly.Memory;
  fill_v0_version(): number;
  fill_v0_revision(): number;
  fill_v0_reserve(inputBytes: number, outputBytes: number): number;
  fill_v0_input_ptr(): number;
  fill_v0_input_capacity(): number;
  fill_v0_output_ptr(): number;
  fill_v0_output_capacity(): number;
  fill_v0_memory_epoch(): number;
  fill_v0_process(inputLength: number): number;
  fill_v0_result_len(): number;
  fill_v0_required_output_bytes(): number;
  fill_v0_dispose(): number;
}

const FILL_EXPORT_NAMES = [
  'fill_v0_version',
  'fill_v0_revision',
  'fill_v0_reserve',
  'fill_v0_input_ptr',
  'fill_v0_input_capacity',
  'fill_v0_output_ptr',
  'fill_v0_output_capacity',
  'fill_v0_memory_epoch',
  'fill_v0_process',
  'fill_v0_result_len',
  'fill_v0_required_output_bytes',
  'fill_v0_dispose',
] as const;

export interface FillMeshAdapter extends FillMeshPort {
  readonly portVersion: 0;
  readonly operationId: 'geometry-wasm/fill-v0';
  /** Terminal and idempotent. Later calls return batch-failed: disposed. */
  dispose(): void;
  /** Current byteLength of this adapter's own linear memory. */
  linearMemoryBytes(): number;
}

/** A breach of the frozen fill-v0 ABI; the adapter fails closed. */
class FillAbiBreach extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FillAbiBreach';
  }
}

/** A host typed-array allocation failed; the adapter stays usable. */
class HostAllocationFailure extends Error {
  constructor(cause: RangeError) {
    super(cause.message);
    this.name = 'HostAllocationFailure';
  }
}

/** A caller-owned request object failed validation or threw. */
class InvalidRequest extends Error {}

interface MemoryState {
  readonly buffer: ArrayBuffer;
  readonly byteLength: number;
  readonly epoch: number;
  readonly inputPointer: number;
  readonly inputCapacity: number;
  readonly outputPointer: number;
  readonly outputCapacity: number;
}

interface ValidatedRequest {
  readonly requestId: number;
  readonly verbs: Uint8Array;
  readonly points: Float64Array;
  readonly rule: 0 | 1;
  /** The caller's exponent, echoed unchanged. */
  readonly exponent: number;
  /** The i32 exponent written to the kernel. */
  readonly encodedExponent: number;
}

function isU32(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= MAX_U32;
}

function align8(value: number): number {
  return Math.ceil(value / 8) * 8;
}

function allocate<T>(create: () => T): T {
  try {
    return create();
  } catch (error) {
    if (error instanceof RangeError) throw new HostAllocationFailure(error);
    throw error;
  }
}

function batchFailed(
  code: 'invalid-request' | 'disposed' | 'resource-limit' | 'internal-error',
): FillMeshBatchResult {
  return { status: 'batch-failed', code };
}

function validateRequests(requests: readonly FillMeshRequest[]): ValidatedRequest[] {
  if (!Array.isArray(requests)) throw new InvalidRequest('requests must be an array');
  const length = requests.length;
  const seen = new Set<number>();
  const validated: ValidatedRequest[] = [];
  for (let index = 0; index < length; index += 1) {
    if (!(index in requests)) throw new InvalidRequest('requests must not be sparse');
    const request: unknown = requests[index];
    if (typeof request !== 'object' || request === null) {
      throw new InvalidRequest('request must be an object');
    }
    const candidate = request as Record<string, unknown>;
    const requestId = candidate.requestId;
    if (!isU32(requestId)) throw new InvalidRequest('requestId must be a u32 integer');
    if (seen.has(requestId)) throw new InvalidRequest('requestId must be unique');
    seen.add(requestId);
    const verbs = candidate.verbs;
    if (!(verbs instanceof Uint8Array)) throw new InvalidRequest('verbs must be a Uint8Array');
    const points = candidate.points;
    if (!(points instanceof Float64Array)) {
      throw new InvalidRequest('points must be a Float64Array');
    }
    const fillRule = candidate.fillRule;
    if (fillRule !== 'nonzero' && fillRule !== 'evenodd') {
      throw new InvalidRequest("fillRule must be 'nonzero' or 'evenodd'");
    }
    const exponent = candidate.toleranceExponent;
    if (typeof exponent !== 'number' || !Number.isInteger(exponent)) {
      throw new InvalidRequest('toleranceExponent must be a finite integer');
    }
    validated.push({
      requestId,
      verbs,
      points,
      rule: fillRule === 'nonzero' ? 0 : 1,
      exponent,
      encodedExponent: exponent >= I32_MIN && exponent <= I32_MAX ? exponent : I32_MIN,
    });
  }
  return validated;
}

interface InputLayout {
  readonly verbCount: number;
  readonly pointCount: number;
  readonly pathOffsets: number;
  readonly pointOffsets: number;
  readonly verbsOffset: number;
  readonly pointsOffset: number;
  readonly totalBytes: number;
}

function inputLayout(requests: readonly ValidatedRequest[]): InputLayout {
  let verbCount = 0;
  let pointCount = 0;
  for (const request of requests) {
    verbCount += request.verbs.length;
    pointCount += request.points.length;
  }
  const pathOffsets = INPUT_HEADER_BYTES + REQUEST_BYTES * requests.length;
  const pointOffsets = pathOffsets + 4 * (requests.length + 1);
  const verbsOffset = pointOffsets + 4 * (requests.length + 1);
  const pointsOffset = align8(verbsOffset + verbCount);
  return {
    verbCount,
    pointCount,
    pathOffsets,
    pointOffsets,
    verbsOffset,
    pointsOffset,
    totalBytes: pointsOffset + 8 * pointCount,
  };
}

function packInput(requests: readonly ValidatedRequest[], layout: InputLayout): Uint8Array {
  const bytes = allocate(() => new Uint8Array(layout.totalBytes));
  const view = new DataView(bytes.buffer);
  const header = [
    INPUT_MAGIC,
    FILL_V0_VERSION,
    layout.totalBytes,
    requests.length,
    layout.verbCount,
    layout.pointCount,
    INPUT_HEADER_BYTES,
    layout.pathOffsets,
    layout.pointOffsets,
    layout.verbsOffset,
    layout.pointsOffset,
    0,
  ];
  header.forEach((value, index) => view.setUint32(index * 4, value, true));
  let verbCursor = 0;
  let pointCursor = 0;
  requests.forEach((request, index) => {
    const offset = INPUT_HEADER_BYTES + REQUEST_BYTES * index;
    view.setUint32(offset, request.requestId, true);
    view.setUint32(offset + 4, request.rule, true);
    view.setInt32(offset + 8, request.encodedExponent, true);
    view.setUint32(layout.pathOffsets + 4 * index, verbCursor, true);
    view.setUint32(layout.pointOffsets + 4 * index, pointCursor, true);
    bytes.set(request.verbs, layout.verbsOffset + verbCursor);
    const pointBase = layout.pointsOffset + 8 * pointCursor;
    for (let scalar = 0; scalar < request.points.length; scalar += 1) {
      view.setFloat64(pointBase + 8 * scalar, request.points[scalar]!, true);
    }
    verbCursor += request.verbs.length;
    pointCursor += request.points.length;
  });
  view.setUint32(layout.pathOffsets + 4 * requests.length, verbCursor, true);
  view.setUint32(layout.pointOffsets + 4 * requests.length, pointCursor, true);
  return bytes;
}

function rangesOverlap(
  leftStart: number,
  leftLength: number,
  rightStart: number,
  rightLength: number,
): boolean {
  return leftStart < rightStart + rightLength && rightStart < leftStart + leftLength;
}

class FillMeshKernelAdapter implements FillMeshAdapter {
  readonly portVersion = 0 as const;
  readonly operationId = FILL_V0_OPERATION_ID;
  private kernel: FillKernelExports | null;
  private readonly memory: WebAssembly.Memory;
  private state: MemoryState | null = null;
  private needsReserve = true;

  constructor(
    kernel: FillKernelExports,
    private readonly onFailClosed: ((reason: string) => void) | undefined,
  ) {
    this.kernel = kernel;
    this.memory = kernel.memory;
  }

  linearMemoryBytes(): number {
    return this.memory.buffer.byteLength;
  }

  dispose(): void {
    const kernel = this.kernel;
    this.kernel = null;
    this.state = null;
    if (kernel === null) return;
    try {
      kernel.fill_v0_dispose();
    } catch {
      // Disposal is terminal for the adapter whatever the kernel does.
    }
  }

  buildFillMeshes(requests: readonly FillMeshRequest[]): FillMeshBatchResult {
    const kernel = this.kernel;
    if (kernel === null) return batchFailed('disposed');
    let validated: ValidatedRequest[];
    try {
      validated = validateRequests(requests);
    } catch {
      return batchFailed('invalid-request');
    }
    const layout = inputLayout(validated);
    if (layout.totalBytes > INPUT_CAP_BYTES) return batchFailed('resource-limit');
    if (validated.length === 0) return { status: 'ok', results: [] };
    try {
      return this.run(kernel, validated, layout);
    } catch (error) {
      if (error instanceof HostAllocationFailure) return batchFailed('resource-limit');
      return this.failClosed(error);
    }
  }

  private run(
    kernel: FillKernelExports,
    requests: readonly ValidatedRequest[],
    layout: InputLayout,
  ): FillMeshBatchResult {
    const input = packInput(requests, layout);
    if (this.state === null) this.state = this.readState(kernel);
    const minimumOutput = OUTPUT_HEADER_BYTES + RESULT_BYTES * requests.length;
    if (
      this.needsReserve ||
      this.state.inputCapacity < input.byteLength ||
      this.state.outputCapacity < minimumOutput
    ) {
      const outcome = this.reserve(
        kernel,
        Math.max(input.byteLength, this.state.inputCapacity),
        Math.min(Math.max(minimumOutput, this.state.outputCapacity), OUTPUT_CAP_BYTES + 1),
      );
      if (outcome !== null) return outcome;
    }
    this.copyInput(input);
    let status = this.process(kernel, input.byteLength);
    if (status === BATCH.OUTPUT_CAPACITY) {
      const required = kernel.fill_v0_required_output_bytes();
      if (
        !isU32(required) ||
        required === 0 ||
        required <= this.current().outputCapacity ||
        required > OUTPUT_CAP_BYTES
      ) {
        throw new FillAbiBreach('OUTPUT_CAPACITY without a larger exact requirement');
      }
      const outcome = this.reserve(kernel, input.byteLength, required);
      if (outcome !== null) return outcome;
      if (this.current().outputCapacity < required) {
        throw new FillAbiBreach('reserve did not provide the required output capacity');
      }
      this.copyInput(input);
      status = this.process(kernel, input.byteLength);
      if (status === BATCH.OUTPUT_CAPACITY) {
        throw new FillAbiBreach('second OUTPUT_CAPACITY after an exact reserve');
      }
    }
    switch (status) {
      case BATCH.OK:
        return this.decode(kernel, requests);
      case BATCH.RESOURCE_LIMIT:
        this.assertNoRequirement(kernel);
        return batchFailed('resource-limit');
      case BATCH.ALLOCATION_FAILED:
        this.needsReserve = true;
        return batchFailed('resource-limit');
      case BATCH.INTERNAL_ERROR:
        // A per-path self-check failure: the engine stays consistent.
        return batchFailed('internal-error');
      case BATCH.DISPOSED:
        this.kernel = null;
        this.state = null;
        return batchFailed('disposed');
      default:
        throw new FillAbiBreach(`process returned status ${String(status)}`);
    }
  }

  /** Returns null on success, or the batch outcome of a failed reserve. */
  private reserve(
    kernel: FillKernelExports,
    inputBytes: number,
    outputBytes: number,
  ): FillMeshBatchResult | null {
    const status = this.mutate(kernel, true, () => kernel.fill_v0_reserve(inputBytes, outputBytes));
    switch (status) {
      case BATCH.OK: {
        const state = this.current();
        if (state.inputCapacity < inputBytes || state.outputCapacity < outputBytes) {
          throw new FillAbiBreach('reserve returned OK below the requested capacity');
        }
        this.needsReserve = false;
        return null;
      }
      case BATCH.RESOURCE_LIMIT:
        this.assertNoRequirement(kernel);
        return batchFailed('resource-limit');
      case BATCH.ALLOCATION_FAILED:
        this.assertNoResult(kernel);
        this.needsReserve = true;
        return batchFailed('resource-limit');
      case BATCH.DISPOSED:
        this.kernel = null;
        this.state = null;
        return batchFailed('disposed');
      default:
        throw new FillAbiBreach(`reserve returned status ${String(status)}`);
    }
  }

  private process(kernel: FillKernelExports, inputLength: number): number {
    const status = this.mutate(kernel, false, () => kernel.fill_v0_process(inputLength));
    if (status !== BATCH.OK) this.assertNoResult(kernel);
    return status;
  }

  private assertNoResult(kernel: FillKernelExports): void {
    if (kernel.fill_v0_result_len() !== 0) {
      throw new FillAbiBreach('a failure published a readable result');
    }
  }

  private assertNoRequirement(kernel: FillKernelExports): void {
    this.assertNoResult(kernel);
    if (kernel.fill_v0_required_output_bytes() !== 0) {
      throw new FillAbiBreach('RESOURCE_LIMIT published an output requirement');
    }
  }

  private current(): MemoryState {
    if (this.state === null) throw new FillAbiBreach('memory state is unavailable');
    return this.state;
  }

  private mutate(
    kernel: FillKernelExports,
    allowStorageChange: boolean,
    call: () => number,
  ): number {
    const before = this.current();
    if (before.epoch === MAX_U32) throw new FillAbiBreach('fill memory epoch is exhausted');
    const status = call();
    if (!isU32(status)) throw new FillAbiBreach('kernel returned a non-u32 status');
    const after = this.readState(kernel);
    if (after.epoch !== before.epoch + 1) {
      throw new FillAbiBreach('memory epoch did not advance exactly once');
    }
    if (
      !allowStorageChange &&
      (after.buffer !== before.buffer ||
        after.byteLength !== before.byteLength ||
        after.inputPointer !== before.inputPointer ||
        after.inputCapacity !== before.inputCapacity ||
        after.outputPointer !== before.outputPointer ||
        after.outputCapacity !== before.outputCapacity)
    ) {
      throw new FillAbiBreach('process changed linear-memory storage');
    }
    this.state = after;
    return status;
  }

  private readState(kernel: FillKernelExports): MemoryState {
    const buffer: unknown = kernel.memory.buffer;
    if (!(buffer instanceof ArrayBuffer)) throw new FillAbiBreach('memory is not an ArrayBuffer');
    const state: MemoryState = {
      buffer,
      byteLength: buffer.byteLength,
      epoch: kernel.fill_v0_memory_epoch(),
      inputPointer: kernel.fill_v0_input_ptr(),
      inputCapacity: kernel.fill_v0_input_capacity(),
      outputPointer: kernel.fill_v0_output_ptr(),
      outputCapacity: kernel.fill_v0_output_capacity(),
    };
    for (const value of [
      state.epoch,
      state.inputPointer,
      state.inputCapacity,
      state.outputPointer,
      state.outputCapacity,
    ]) {
      if (!isU32(value)) throw new FillAbiBreach('memory state is not u32');
    }
    if (
      state.inputPointer + state.inputCapacity > state.byteLength ||
      state.outputPointer + state.outputCapacity > state.byteLength
    ) {
      throw new FillAbiBreach('an arena lies outside linear memory');
    }
    if (state.inputCapacity > INPUT_CAP_BYTES || state.outputCapacity > OUTPUT_CAP_BYTES) {
      throw new FillAbiBreach('an arena exceeds the transport caps');
    }
    if (state.inputPointer % 8 !== 0 || state.outputPointer % 8 !== 0) {
      throw new FillAbiBreach('an arena is not 8-byte aligned');
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
      throw new FillAbiBreach('input and output arenas overlap');
    }
    return state;
  }

  private copyInput(input: Uint8Array): void {
    const state = this.current();
    if (input.byteLength > state.inputCapacity) {
      throw new FillAbiBreach('input arena is smaller than the packed input');
    }
    new Uint8Array(state.buffer, state.inputPointer, input.byteLength).set(input);
  }

  private decode(
    kernel: FillKernelExports,
    requests: readonly ValidatedRequest[],
  ): FillMeshBatchResult {
    const state = this.current();
    const total = kernel.fill_v0_result_len();
    if (!isU32(total) || total < OUTPUT_HEADER_BYTES || total > state.outputCapacity) {
      throw new FillAbiBreach('OK published an invalid result length');
    }
    const view = new DataView(state.buffer, state.outputPointer, total);
    const u32 = (offset: number): number => view.getUint32(offset, true);
    const count = requests.length;
    const dataOffset = OUTPUT_HEADER_BYTES + RESULT_BYTES * count;
    if (
      u32(0) !== OUTPUT_MAGIC ||
      u32(4) !== FILL_V0_VERSION ||
      u32(8) !== total ||
      u32(12) !== count ||
      u32(16) !== OUTPUT_HEADER_BYTES ||
      u32(20) !== dataOffset ||
      dataOffset > total
    ) {
      throw new FillAbiBreach('output header is inconsistent');
    }
    for (let field = 6; field < 16; field += 1) {
      if (u32(field * 4) !== 0) throw new FillAbiBreach('output header reserved field is set');
    }
    const results: FillMeshResult[] = [];
    let cursor = dataOffset;
    for (let index = 0; index < count; index += 1) {
      const request = requests[index]!;
      const record = OUTPUT_HEADER_BYTES + RESULT_BYTES * index;
      const status = u32(record + 4);
      if (
        u32(record) !== request.requestId ||
        view.getInt32(record + 8, true) !== request.encodedExponent
      ) {
        throw new FillAbiBreach('result echo differs from the request');
      }
      for (const reserved of [12, 36, 40, 44]) {
        if (u32(record + reserved) !== 0) throw new FillAbiBreach('record reserved field is set');
      }
      const echo = { requestId: request.requestId, toleranceExponent: request.exponent };
      if (status !== PATH_OK) {
        for (let offset = 16; offset < RESULT_BYTES; offset += 4) {
          if (offset >= 36 && offset < 48) continue;
          if (u32(record + offset) !== 0) {
            throw new FillAbiBreach('a non-OK record carries mesh fields');
          }
        }
        if (status === PATH_EMPTY) {
          results.push({ ...echo, status: 'empty' });
          continue;
        }
        const code = PATH_FAILURES[status];
        if (code === undefined || code === null) {
          throw new FillAbiBreach(`unknown path status ${String(status)}`);
        }
        results.push({ ...echo, status: 'failed', code });
        continue;
      }
      const blockOffset = u32(record + 16);
      const vertexCount = u32(record + 20);
      const indexCount = u32(record + 24);
      const boundaryCount = u32(record + 28);
      const blockBytes = u32(record + 32);
      if (
        vertexCount === 0 ||
        indexCount === 0 ||
        indexCount % 3 !== 0 ||
        boundaryCount % 2 !== 0 ||
        blockOffset !== cursor
      ) {
        throw new FillAbiBreach('an OK record has inconsistent counts or offsets');
      }
      const payload = 16 * vertexCount + 4 * (indexCount + boundaryCount);
      if (blockBytes !== align8(payload) || cursor + blockBytes > total) {
        throw new FillAbiBreach('an OK block has an inconsistent size');
      }
      cursor += blockBytes;
      const base = state.outputPointer + blockOffset;
      const positionsView = new Float64Array(state.buffer, base, 2 * vertexCount);
      const indicesView = new Uint32Array(state.buffer, base + 16 * vertexCount, indexCount);
      const boundaryView = new Uint32Array(
        state.buffer,
        base + 16 * vertexCount + 4 * indexCount,
        boundaryCount,
      );
      const positions = allocate(() => positionsView.slice());
      const indices = allocate(() => indicesView.slice());
      const boundaryEdges = allocate(() => boundaryView.slice());
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      for (let scalar = 0; scalar < positions.length; scalar += 2) {
        const x = positions[scalar]!;
        const y = positions[scalar + 1]!;
        if (!Number.isFinite(x) || !Number.isFinite(y)) {
          throw new FillAbiBreach('a position is not finite');
        }
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
      }
      if (
        view.getFloat64(record + 48, true) !== minX ||
        view.getFloat64(record + 56, true) !== minY ||
        view.getFloat64(record + 64, true) !== maxX ||
        view.getFloat64(record + 72, true) !== maxY
      ) {
        throw new FillAbiBreach('bounds differ from the recomputed vertex bounds');
      }
      for (const vertex of indices) {
        if (vertex >= vertexCount) throw new FillAbiBreach('an index is outside the vertices');
      }
      for (const vertex of boundaryEdges) {
        if (vertex >= vertexCount) {
          throw new FillAbiBreach('a boundary index is outside the vertices');
        }
      }
      const mesh: FillMesh = {
        positions,
        indices,
        boundaryEdges,
        bounds: { minX, minY, maxX, maxY },
      };
      results.push({ ...echo, status: 'ok', mesh });
    }
    if (cursor !== total) throw new FillAbiBreach('output total differs from the blocks');
    return { status: 'ok', results };
  }

  private failClosed(error: unknown): FillMeshBatchResult {
    try {
      this.onFailClosed?.(error instanceof Error ? error.message : String(error));
    } catch {
      // A diagnostic observer cannot keep a breached adapter open.
    }
    this.dispose();
    return batchFailed('internal-error');
  }
}

function isLittleEndianHost(): boolean {
  return new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;
}

/**
 * Wraps an instance's `fill_v0_*` exports. It checks that every export
 * exists and that the version and revision match; on any failure it disposes
 * the kernel and throws. Tests use it to wrap export objects.
 */
export function createFillMeshPortFromExports(
  exports: FillKernelExports,
  options: Readonly<{ onFailClosed?: (reason: string) => void }> = {},
): FillMeshAdapter {
  const candidate = exports as unknown as Record<string, unknown>;
  const dispose = (): void => {
    try {
      if (typeof candidate.fill_v0_dispose === 'function') {
        (candidate.fill_v0_dispose as () => number)();
      }
    } catch {
      // The factory rejects regardless.
    }
  };
  try {
    if (!isLittleEndianHost()) throw new Error('fill-v0 requires a little-endian host');
    if (!(candidate.memory instanceof WebAssembly.Memory)) {
      throw new Error('fill-v0 kernel exports no memory');
    }
    for (const name of FILL_EXPORT_NAMES) {
      if (typeof candidate[name] !== 'function')
        throw new Error(`fill-v0 export ${name} is missing`);
    }
    if (exports.fill_v0_version() !== FILL_V0_VERSION) {
      throw new Error('fill-v0 transport version mismatch');
    }
    if (exports.fill_v0_revision() !== FILL_V0_REVISION) {
      throw new Error('fill-v0 kernel revision mismatch');
    }
  } catch (error) {
    dispose();
    throw error;
  }
  return new FillMeshKernelAdapter(exports, options.onFailClosed);
}

/**
 * Instantiates a new kernel instance that this adapter alone owns
 * (contract section b) and returns a `FillMeshPort` over its fill-v0 exports.
 */
export async function createFillMeshPort(
  source: WebAssembly.Module | BufferSource,
): Promise<FillMeshAdapter> {
  let instance: WebAssembly.Instance;
  if (source instanceof WebAssembly.Module) {
    instance = await WebAssembly.instantiate(source, {});
  } else {
    instance = (await WebAssembly.instantiate(source, {})).instance;
  }
  return createFillMeshPortFromExports(instance.exports as unknown as FillKernelExports);
}
