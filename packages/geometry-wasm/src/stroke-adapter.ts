import type {
  StrokeMesh,
  StrokeMeshBatchResult,
  StrokeMeshFailureCode,
  StrokeMeshPort,
  StrokeMeshRequest,
  StrokeMeshResult,
} from '@vector-studio/contracts';

// P3 B2 stroke-mesh transport v0 adapter (docs/plans/p3-b2-stroke-contract.md, sections 7
// and 8). It follows the V2 fill adapter (p3-v2-fill-mesh-transport-contract.md, section h)
// with "stroke" for "fill": its own instance, the same batch-level checks, one capacity retry,
// owned copies and the same fail-closed list. Results are functional evidence; precision is
// UNVERIFIED against the 0.25 physical-pixel target until B4 has A04 evidence.

export const STROKE_V0_OPERATION_ID = 'geometry-wasm/stroke-v0+r7';
export const STROKE_V0_VERSION = 0;
/** The kernel revision this adapter was built for. */
export const STROKE_V0_REVISION = 7;

const INPUT_MAGIC = 0x3054_4756;
const OUTPUT_MAGIC = 0x3055_4756;
const INPUT_HEADER_BYTES = 48;
const REQUEST_BYTES = 32;
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
/** Section 7.2 path statuses 2-7, exhaustively. */
const PATH_FAILURES: readonly (StrokeMeshFailureCode | null)[] = [
  null,
  null,
  'invalid-path',
  'invalid-tolerance',
  'numeric-range',
  'work-limit',
  'unsupported-geometry',
  'invalid-stroke',
];

const CAP_CODES = { butt: 0, round: 1, square: 2 } as const;
const JOIN_CODES = { miter: 0, round: 1, bevel: 2 } as const;

/** The `stroke_v0_*` export family of the geometry kernel. */
export interface StrokeKernelExports {
  readonly memory: WebAssembly.Memory;
  stroke_v0_version(): number;
  stroke_v0_revision(): number;
  stroke_v0_reserve(inputBytes: number, outputBytes: number): number;
  stroke_v0_input_ptr(): number;
  stroke_v0_input_capacity(): number;
  stroke_v0_output_ptr(): number;
  stroke_v0_output_capacity(): number;
  stroke_v0_memory_epoch(): number;
  stroke_v0_process(inputLength: number): number;
  stroke_v0_result_len(): number;
  stroke_v0_required_output_bytes(): number;
  stroke_v0_dispose(): number;
}

const STROKE_EXPORT_NAMES = [
  'stroke_v0_version',
  'stroke_v0_revision',
  'stroke_v0_reserve',
  'stroke_v0_input_ptr',
  'stroke_v0_input_capacity',
  'stroke_v0_output_ptr',
  'stroke_v0_output_capacity',
  'stroke_v0_memory_epoch',
  'stroke_v0_process',
  'stroke_v0_result_len',
  'stroke_v0_required_output_bytes',
  'stroke_v0_dispose',
] as const;

export interface StrokeMeshAdapter extends StrokeMeshPort {
  readonly portVersion: 0;
  readonly operationId: 'geometry-wasm/stroke-v0+r7';
  /** Terminal and idempotent. Later calls return batch-failed: disposed. */
  dispose(): void;
  /** Current byteLength of this adapter's own linear memory. */
  linearMemoryBytes(): number;
}

/** A breach of the frozen stroke-v0 ABI; the adapter fails closed. */
class StrokeAbiBreach extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StrokeAbiBreach';
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
  readonly cap: 0 | 1 | 2;
  readonly join: 0 | 1 | 2;
  /** Passed through as is; a number that is not a valid width is per-path invalid-stroke. */
  readonly width: number;
  readonly miterLimit: number;
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
): StrokeMeshBatchResult {
  return { status: 'batch-failed', code };
}

function capCode(value: unknown): 0 | 1 | 2 {
  if (value === 'butt' || value === 'round' || value === 'square') return CAP_CODES[value];
  throw new InvalidRequest("cap must be 'butt', 'round' or 'square'");
}

function joinCode(value: unknown): 0 | 1 | 2 {
  if (value === 'miter' || value === 'round' || value === 'bevel') return JOIN_CODES[value];
  throw new InvalidRequest("join must be 'miter', 'round' or 'bevel'");
}

function validateRequests(requests: readonly StrokeMeshRequest[]): ValidatedRequest[] {
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
    const width = candidate.width;
    if (typeof width !== 'number') throw new InvalidRequest('width must be a number');
    const cap = capCode(candidate.cap);
    const join = joinCode(candidate.join);
    const miterLimit = candidate.miterLimit;
    if (typeof miterLimit !== 'number') throw new InvalidRequest('miterLimit must be a number');
    const exponent = candidate.toleranceExponent;
    if (typeof exponent !== 'number' || !Number.isInteger(exponent)) {
      throw new InvalidRequest('toleranceExponent must be a finite integer');
    }
    validated.push({
      requestId,
      verbs,
      points,
      cap,
      join,
      width,
      miterLimit,
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
    STROKE_V0_VERSION,
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
    view.setUint32(offset + 4, request.cap, true);
    view.setUint32(offset + 8, request.join, true);
    view.setInt32(offset + 12, request.encodedExponent, true);
    view.setFloat64(offset + 16, request.width, true);
    view.setFloat64(offset + 24, request.miterLimit, true);
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

class StrokeMeshKernelAdapter implements StrokeMeshAdapter {
  readonly portVersion = 0 as const;
  readonly operationId = STROKE_V0_OPERATION_ID;
  private kernel: StrokeKernelExports | null;
  private readonly memory: WebAssembly.Memory;
  private state: MemoryState | null = null;
  private needsReserve = true;

  constructor(
    kernel: StrokeKernelExports,
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
      kernel.stroke_v0_dispose();
    } catch {
      // Disposal is terminal for the adapter whatever the kernel does.
    }
  }

  buildStrokeMeshes(requests: readonly StrokeMeshRequest[]): StrokeMeshBatchResult {
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
    kernel: StrokeKernelExports,
    requests: readonly ValidatedRequest[],
    layout: InputLayout,
  ): StrokeMeshBatchResult {
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
      const required = kernel.stroke_v0_required_output_bytes();
      if (
        !isU32(required) ||
        required === 0 ||
        required <= this.current().outputCapacity ||
        required > OUTPUT_CAP_BYTES
      ) {
        throw new StrokeAbiBreach('OUTPUT_CAPACITY without a larger exact requirement');
      }
      const outcome = this.reserve(kernel, input.byteLength, required);
      if (outcome !== null) return outcome;
      if (this.current().outputCapacity < required) {
        throw new StrokeAbiBreach('reserve did not provide the required output capacity');
      }
      this.copyInput(input);
      status = this.process(kernel, input.byteLength);
      if (status === BATCH.OUTPUT_CAPACITY) {
        throw new StrokeAbiBreach('second OUTPUT_CAPACITY after an exact reserve');
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
        throw new StrokeAbiBreach(`process returned status ${String(status)}`);
    }
  }

  /** Returns null on success, or the batch outcome of a failed reserve. */
  private reserve(
    kernel: StrokeKernelExports,
    inputBytes: number,
    outputBytes: number,
  ): StrokeMeshBatchResult | null {
    const status = this.mutate(kernel, true, () =>
      kernel.stroke_v0_reserve(inputBytes, outputBytes),
    );
    switch (status) {
      case BATCH.OK: {
        const state = this.current();
        if (state.inputCapacity < inputBytes || state.outputCapacity < outputBytes) {
          throw new StrokeAbiBreach('reserve returned OK below the requested capacity');
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
        throw new StrokeAbiBreach(`reserve returned status ${String(status)}`);
    }
  }

  private process(kernel: StrokeKernelExports, inputLength: number): number {
    const status = this.mutate(kernel, false, () => kernel.stroke_v0_process(inputLength));
    if (status !== BATCH.OK) this.assertNoResult(kernel);
    return status;
  }

  private assertNoResult(kernel: StrokeKernelExports): void {
    if (kernel.stroke_v0_result_len() !== 0) {
      throw new StrokeAbiBreach('a failure published a readable result');
    }
  }

  private assertNoRequirement(kernel: StrokeKernelExports): void {
    this.assertNoResult(kernel);
    if (kernel.stroke_v0_required_output_bytes() !== 0) {
      throw new StrokeAbiBreach('RESOURCE_LIMIT published an output requirement');
    }
  }

  private current(): MemoryState {
    if (this.state === null) throw new StrokeAbiBreach('memory state is unavailable');
    return this.state;
  }

  private mutate(
    kernel: StrokeKernelExports,
    allowStorageChange: boolean,
    call: () => number,
  ): number {
    const before = this.current();
    if (before.epoch === MAX_U32) throw new StrokeAbiBreach('stroke memory epoch is exhausted');
    const status = call();
    if (!isU32(status)) throw new StrokeAbiBreach('kernel returned a non-u32 status');
    const after = this.readState(kernel);
    if (after.epoch !== before.epoch + 1) {
      throw new StrokeAbiBreach('memory epoch did not advance exactly once');
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
      throw new StrokeAbiBreach('process changed linear-memory storage');
    }
    this.state = after;
    return status;
  }

  private readState(kernel: StrokeKernelExports): MemoryState {
    const buffer: unknown = kernel.memory.buffer;
    if (!(buffer instanceof ArrayBuffer)) {
      throw new StrokeAbiBreach('memory is not an ArrayBuffer');
    }
    const state: MemoryState = {
      buffer,
      byteLength: buffer.byteLength,
      epoch: kernel.stroke_v0_memory_epoch(),
      inputPointer: kernel.stroke_v0_input_ptr(),
      inputCapacity: kernel.stroke_v0_input_capacity(),
      outputPointer: kernel.stroke_v0_output_ptr(),
      outputCapacity: kernel.stroke_v0_output_capacity(),
    };
    for (const value of [
      state.epoch,
      state.inputPointer,
      state.inputCapacity,
      state.outputPointer,
      state.outputCapacity,
    ]) {
      if (!isU32(value)) throw new StrokeAbiBreach('memory state is not u32');
    }
    if (
      state.inputPointer + state.inputCapacity > state.byteLength ||
      state.outputPointer + state.outputCapacity > state.byteLength
    ) {
      throw new StrokeAbiBreach('an arena lies outside linear memory');
    }
    if (state.inputCapacity > INPUT_CAP_BYTES || state.outputCapacity > OUTPUT_CAP_BYTES) {
      throw new StrokeAbiBreach('an arena exceeds the transport caps');
    }
    if (state.inputPointer % 8 !== 0 || state.outputPointer % 8 !== 0) {
      throw new StrokeAbiBreach('an arena is not 8-byte aligned');
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
      throw new StrokeAbiBreach('input and output arenas overlap');
    }
    return state;
  }

  private copyInput(input: Uint8Array): void {
    const state = this.current();
    if (input.byteLength > state.inputCapacity) {
      throw new StrokeAbiBreach('input arena is smaller than the packed input');
    }
    new Uint8Array(state.buffer, state.inputPointer, input.byteLength).set(input);
  }

  private decode(
    kernel: StrokeKernelExports,
    requests: readonly ValidatedRequest[],
  ): StrokeMeshBatchResult {
    const state = this.current();
    const total = kernel.stroke_v0_result_len();
    if (!isU32(total) || total < OUTPUT_HEADER_BYTES || total > state.outputCapacity) {
      throw new StrokeAbiBreach('OK published an invalid result length');
    }
    const view = new DataView(state.buffer, state.outputPointer, total);
    const u32 = (offset: number): number => view.getUint32(offset, true);
    const count = requests.length;
    const dataOffset = OUTPUT_HEADER_BYTES + RESULT_BYTES * count;
    if (
      u32(0) !== OUTPUT_MAGIC ||
      u32(4) !== STROKE_V0_VERSION ||
      u32(8) !== total ||
      u32(12) !== count ||
      u32(16) !== OUTPUT_HEADER_BYTES ||
      u32(20) !== dataOffset ||
      dataOffset > total
    ) {
      throw new StrokeAbiBreach('output header is inconsistent');
    }
    for (let field = 6; field < 16; field += 1) {
      if (u32(field * 4) !== 0) throw new StrokeAbiBreach('output header reserved field is set');
    }
    const results: StrokeMeshResult[] = [];
    let cursor = dataOffset;
    for (let index = 0; index < count; index += 1) {
      const request = requests[index]!;
      const record = OUTPUT_HEADER_BYTES + RESULT_BYTES * index;
      const status = u32(record + 4);
      if (
        u32(record) !== request.requestId ||
        view.getInt32(record + 8, true) !== request.encodedExponent
      ) {
        throw new StrokeAbiBreach('result echo differs from the request');
      }
      for (const reserved of [12, 36, 40, 44]) {
        if (u32(record + reserved) !== 0) {
          throw new StrokeAbiBreach('record reserved field is set');
        }
      }
      const echo = { requestId: request.requestId, toleranceExponent: request.exponent };
      if (status !== PATH_OK) {
        for (let offset = 16; offset < RESULT_BYTES; offset += 4) {
          if (offset >= 36 && offset < 48) continue;
          if (u32(record + offset) !== 0) {
            throw new StrokeAbiBreach('a non-OK record carries mesh fields');
          }
        }
        if (status === PATH_EMPTY) {
          results.push({ ...echo, status: 'empty' });
          continue;
        }
        const code = PATH_FAILURES[status];
        if (code === undefined || code === null) {
          throw new StrokeAbiBreach(`unknown path status ${String(status)}`);
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
        throw new StrokeAbiBreach('an OK record has inconsistent counts or offsets');
      }
      const payload = 16 * vertexCount + 4 * (indexCount + boundaryCount);
      if (blockBytes !== align8(payload) || cursor + blockBytes > total) {
        throw new StrokeAbiBreach('an OK block has an inconsistent size');
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
          throw new StrokeAbiBreach('a position is not finite');
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
        throw new StrokeAbiBreach('bounds differ from the recomputed vertex bounds');
      }
      for (const vertex of indices) {
        if (vertex >= vertexCount) throw new StrokeAbiBreach('an index is outside the vertices');
      }
      for (const vertex of boundaryEdges) {
        if (vertex >= vertexCount) {
          throw new StrokeAbiBreach('a boundary index is outside the vertices');
        }
      }
      const mesh: StrokeMesh = {
        positions,
        indices,
        boundaryEdges,
        bounds: { minX, minY, maxX, maxY },
      };
      results.push({ ...echo, status: 'ok', mesh });
    }
    if (cursor !== total) throw new StrokeAbiBreach('output total differs from the blocks');
    return { status: 'ok', results };
  }

  private failClosed(error: unknown): StrokeMeshBatchResult {
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
 * Wraps an instance's `stroke_v0_*` exports. It checks that every export
 * exists and that the version and revision match; on any failure it disposes
 * the kernel and throws. Tests use it to wrap export objects.
 */
export function createStrokeMeshPortFromExports(
  exports: StrokeKernelExports,
  options: Readonly<{ onFailClosed?: (reason: string) => void }> = {},
): StrokeMeshAdapter {
  const candidate = exports as unknown as Record<string, unknown>;
  const dispose = (): void => {
    try {
      if (typeof candidate.stroke_v0_dispose === 'function') {
        (candidate.stroke_v0_dispose as () => number)();
      }
    } catch {
      // The factory rejects regardless.
    }
  };
  try {
    if (!isLittleEndianHost()) throw new Error('stroke-v0 requires a little-endian host');
    if (!(candidate.memory instanceof WebAssembly.Memory)) {
      throw new Error('stroke-v0 kernel exports no memory');
    }
    for (const name of STROKE_EXPORT_NAMES) {
      if (typeof candidate[name] !== 'function') {
        throw new Error(`stroke-v0 export ${name} is missing`);
      }
    }
    if (exports.stroke_v0_version() !== STROKE_V0_VERSION) {
      throw new Error('stroke-v0 transport version mismatch');
    }
    if (exports.stroke_v0_revision() !== STROKE_V0_REVISION) {
      throw new Error('stroke-v0 kernel revision mismatch');
    }
  } catch (error) {
    dispose();
    throw error;
  }
  return new StrokeMeshKernelAdapter(exports, options.onFailClosed);
}

/**
 * Instantiates a new kernel instance that this adapter alone owns (contract
 * section 7.5) and returns a `StrokeMeshPort` over its stroke-v0 exports. It
 * shares that instance with no P2 session and no fill adapter.
 */
export async function createStrokeMeshPort(
  source: WebAssembly.Module | BufferSource,
): Promise<StrokeMeshAdapter> {
  let instance: WebAssembly.Instance;
  if (source instanceof WebAssembly.Module) {
    instance = await WebAssembly.instantiate(source, {});
  } else {
    instance = (await WebAssembly.instantiate(source, {})).instance;
  }
  return createStrokeMeshPortFromExports(instance.exports as unknown as StrokeKernelExports);
}
