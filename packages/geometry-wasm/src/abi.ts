import type {
  GeometryBatchErrorCode,
  GeometryBounds,
  GeometryKernelExports,
  GeometryKernelWork,
  GeometryPathErrorCode,
} from './types.js';

export const ABI_VERSION = 1;
export const INPUT_MAGIC = 0x3253_4756;
export const OUTPUT_MAGIC = 0x3252_4756;
export const HEADER_BYTES = 48;
export const REQUEST_BYTES = 24;
export const RESULT_BYTES = 64;
export const PROVENANCE_BYTES = 12;
export const INPUT_CAP_BYTES = 64 * 1024 * 1024;
export const OUTPUT_CAP_BYTES = 256 * 1024 * 1024;
export const MAX_U32 = 0xffff_ffff;

export const BATCH_STATUS = {
  OK: 0,
  INVALID_BATCH: 1,
  OUTPUT_CAPACITY: 2,
  ALLOCATION_FAILED: 3,
  DISPOSED: 4,
  RESOURCE_LIMIT: 5,
  INTERNAL_ERROR: 6,
} as const;

export const PATH_STATUS = {
  OK: 0,
  EMPTY: 1,
  INVALID_PATH: 2,
  INVALID_TOLERANCE: 3,
  NUMERIC_RANGE: 4,
  WORK_LIMIT: 5,
} as const;

export interface PackedPath {
  readonly requestId: number;
  readonly sourceEpoch: number;
  readonly sourceRevision: number;
  readonly tolerance: number;
  readonly verbs: Uint8Array;
  readonly points: Float64Array;
}

export interface DecodedPath {
  readonly requestId: number;
  readonly sourceEpoch: number;
  readonly sourceRevision: number;
  readonly status: 'OK' | 'EMPTY' | GeometryPathErrorCode;
  readonly bounds: GeometryBounds;
  readonly verbs: Uint8Array;
  readonly points: Float64Array;
  readonly provenance: Uint32Array;
}

interface InputLayout {
  readonly pathCount: number;
  readonly verbCount: number;
  readonly pointCount: number;
  readonly requestsOffset: number;
  readonly pathOffsetsOffset: number;
  readonly pointOffsetsOffset: number;
  readonly verbsOffset: number;
  readonly pointsOffset: number;
  readonly totalBytes: number;
}

export class AbiContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AbiContractError';
  }
}

export function alignUp(value: number, alignment: number): number {
  const sum = checkedAdd(value, alignment - 1, 'alignment');
  return sum - (sum % alignment);
}

export function checkedAdd(left: number, right: number, label: string): number {
  const value = left + right;
  if (!Number.isSafeInteger(value) || value > MAX_U32) {
    throw new RangeError(`${label} exceeds the wasm32 unsigned range`);
  }
  return value;
}

export function checkedMultiply(left: number, right: number, label: string): number {
  const value = left * right;
  if (!Number.isSafeInteger(value) || value > MAX_U32) {
    throw new RangeError(`${label} exceeds the wasm32 unsigned range`);
  }
  return value;
}

export function packInput(paths: readonly PackedPath[]): Uint8Array {
  const layout = calculateInputLayout(paths);
  const {
    pathCount,
    verbCount,
    pointCount,
    requestsOffset,
    pathOffsetsOffset,
    pointOffsetsOffset,
    verbsOffset,
    pointsOffset,
    totalBytes,
  } = layout;
  const bytes = new Uint8Array(totalBytes);
  const view = new DataView(bytes.buffer);
  const header = [
    INPUT_MAGIC,
    ABI_VERSION,
    totalBytes,
    pathCount,
    verbCount,
    pointCount,
    requestsOffset,
    pathOffsetsOffset,
    pointOffsetsOffset,
    verbsOffset,
    pointsOffset,
    0,
  ];
  header.forEach((value, index) => view.setUint32(index * 4, value, true));

  let verbCursor = 0;
  let pointCursor = 0;
  paths.forEach((path, index) => {
    const requestOffset = requestsOffset + index * REQUEST_BYTES;
    view.setUint32(requestOffset, path.requestId, true);
    view.setUint32(requestOffset + 4, path.sourceEpoch, true);
    view.setUint32(requestOffset + 8, path.sourceRevision, true);
    view.setUint32(requestOffset + 12, 0, true);
    view.setFloat64(requestOffset + 16, path.tolerance, true);
    view.setUint32(pathOffsetsOffset + index * 4, verbCursor, true);
    view.setUint32(pointOffsetsOffset + index * 4, pointCursor, true);
    bytes.set(path.verbs, verbsOffset + verbCursor);
    path.points.forEach((point, pointIndex) => {
      view.setFloat64(pointsOffset + (pointCursor + pointIndex) * 8, point, true);
    });
    verbCursor += path.verbs.length;
    pointCursor += path.points.length;
  });
  view.setUint32(pathOffsetsOffset + pathCount * 4, verbCursor, true);
  view.setUint32(pointOffsetsOffset + pathCount * 4, pointCursor, true);
  return bytes;
}

export function validatePackedInputSize(paths: readonly PackedPath[]): number {
  return calculateInputLayout(paths).totalBytes;
}

function calculateInputLayout(paths: readonly PackedPath[]): InputLayout {
  const pathCount = paths.length;
  if (pathCount > MAX_U32) throw new RangeError('path count exceeds u32');
  let verbCount = 0;
  let pointCount = 0;
  for (const path of paths) {
    verbCount = checkedAdd(verbCount, path.verbs.length, 'verb count');
    pointCount = checkedAdd(pointCount, path.points.length, 'point scalar count');
  }

  const requestsOffset = alignUp(HEADER_BYTES, 8);
  const pathOffsetsOffset = alignUp(
    checkedAdd(
      requestsOffset,
      checkedMultiply(pathCount, REQUEST_BYTES, 'request bytes'),
      'request end',
    ),
    4,
  );
  const offsetCount = checkedAdd(pathCount, 1, 'offset count');
  const pointOffsetsOffset = alignUp(
    checkedAdd(
      pathOffsetsOffset,
      checkedMultiply(offsetCount, 4, 'path offset bytes'),
      'path offset end',
    ),
    4,
  );
  const verbsOffset = checkedAdd(
    pointOffsetsOffset,
    checkedMultiply(offsetCount, 4, 'point offset bytes'),
    'point offset end',
  );
  const pointsOffset = alignUp(checkedAdd(verbsOffset, verbCount, 'verb end'), 8);
  const totalBytes = checkedAdd(
    pointsOffset,
    checkedMultiply(pointCount, 8, 'point bytes'),
    'input total bytes',
  );
  if (totalBytes > INPUT_CAP_BYTES) throw new RangeError('packed input exceeds the 64 MiB cap');

  return {
    pathCount,
    verbCount,
    pointCount,
    requestsOffset,
    pathOffsetsOffset,
    pointOffsetsOffset,
    verbsOffset,
    pointsOffset,
    totalBytes,
  };
}

export function decodeOutput(bytes: Uint8Array, expected: readonly PackedPath[]): DecodedPath[] {
  if (bytes.byteLength < HEADER_BYTES)
    throw new AbiContractError('output is shorter than its header');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const field = (index: number): number => view.getUint32(index * 4, true);
  if (field(0) !== OUTPUT_MAGIC || field(1) !== ABI_VERSION) {
    throw new AbiContractError('output magic or ABI version is invalid');
  }
  const totalBytes = field(2);
  const pathCount = field(3);
  const verbCount = field(4);
  const pointCount = field(5);
  const resultsOffset = field(6);
  const verbsOffset = field(7);
  const pointsOffset = field(8);
  const provenanceOffset = field(9);
  if (field(10) !== 0 || field(11) !== 0 || totalBytes !== bytes.byteLength) {
    throw new AbiContractError('output length or reserved fields are invalid');
  }
  if (pathCount !== expected.length || totalBytes > OUTPUT_CAP_BYTES) {
    throw new AbiContractError('output path count or total length is invalid');
  }
  let expectedResults: number;
  let expectedVerbs: number;
  let expectedPoints: number;
  let expectedProvenance: number;
  let expectedTotal: number;
  try {
    expectedResults = alignUp(HEADER_BYTES, 8);
    expectedVerbs = checkedAdd(
      expectedResults,
      checkedMultiply(pathCount, RESULT_BYTES, 'result bytes'),
      'result end',
    );
    expectedPoints = alignUp(checkedAdd(expectedVerbs, verbCount, 'output verb end'), 8);
    expectedProvenance = alignUp(
      checkedAdd(
        expectedPoints,
        checkedMultiply(pointCount, 8, 'output point bytes'),
        'output point end',
      ),
      4,
    );
    expectedTotal = checkedAdd(
      expectedProvenance,
      checkedMultiply(verbCount, PROVENANCE_BYTES, 'provenance bytes'),
      'output total bytes',
    );
  } catch (error) {
    if (error instanceof RangeError) {
      throw new AbiContractError(`output layout arithmetic is invalid: ${error.message}`);
    }
    throw error;
  }
  if (
    resultsOffset !== expectedResults ||
    verbsOffset !== expectedVerbs ||
    pointsOffset !== expectedPoints ||
    provenanceOffset !== expectedProvenance ||
    totalBytes !== expectedTotal
  ) {
    throw new AbiContractError('output sections are not canonical');
  }
  assertZero(bytes, HEADER_BYTES, resultsOffset, 'header padding');
  assertZero(bytes, verbsOffset + verbCount, pointsOffset, 'point alignment padding');

  let previousVerbEnd = 0;
  let previousPointEnd = 0;
  const decoded: DecodedPath[] = [];
  for (let index = 0; index < pathCount; index += 1) {
    const offset = resultsOffset + index * RESULT_BYTES;
    const requestId = view.getUint32(offset, true);
    const sourceEpoch = view.getUint32(offset + 4, true);
    const sourceRevision = view.getUint32(offset + 8, true);
    const numericStatus = view.getUint32(offset + 12, true);
    const verbStart = view.getUint32(offset + 16, true);
    const verbEnd = view.getUint32(offset + 20, true);
    const pointStart = view.getUint32(offset + 24, true);
    const pointEnd = view.getUint32(offset + 28, true);
    const source = expected[index];
    if (
      source === undefined ||
      requestId !== source.requestId ||
      sourceEpoch !== source.sourceEpoch ||
      sourceRevision !== source.sourceRevision
    ) {
      throw new AbiContractError('output source echo does not match its input');
    }
    if (
      verbStart !== previousVerbEnd ||
      pointStart !== previousPointEnd ||
      verbEnd < verbStart ||
      pointEnd < pointStart ||
      verbEnd > verbCount ||
      pointEnd > pointCount
    ) {
      throw new AbiContractError('output result ranges are invalid or unordered');
    }
    const status = decodePathStatus(numericStatus);
    const success = status === 'OK';
    if (!success && (verbStart !== verbEnd || pointStart !== pointEnd)) {
      throw new AbiContractError('failed or empty output exposes partial ranges');
    }
    const bounds = {
      minX: view.getFloat64(offset + 32, true),
      minY: view.getFloat64(offset + 40, true),
      maxX: view.getFloat64(offset + 48, true),
      maxY: view.getFloat64(offset + 56, true),
    };
    if (
      success &&
      (!Object.values(bounds).every(Number.isFinite) ||
        bounds.minX > bounds.maxX ||
        bounds.minY > bounds.maxY)
    ) {
      throw new AbiContractError('successful output has nonfinite bounds');
    }
    if (!success && Object.values(bounds).some((value) => value !== 0)) {
      throw new AbiContractError('failed or empty output has nonzero bounds');
    }

    const verbs = bytes.slice(verbsOffset + verbStart, verbsOffset + verbEnd);
    if (verbs.some((verb) => verb !== 0 && verb !== 1 && verb !== 3)) {
      throw new AbiContractError('output contains an unsupported verb');
    }
    const points = new Float64Array(pointEnd - pointStart);
    for (let scalar = pointStart; scalar < pointEnd; scalar += 1) {
      points[scalar - pointStart] = view.getFloat64(pointsOffset + scalar * 8, true);
    }
    if (points.some((point) => !Number.isFinite(point))) {
      throw new AbiContractError('successful output contains a nonfinite coordinate');
    }
    const provenance = new Uint32Array((verbEnd - verbStart) * 3);
    for (let verb = verbStart; verb < verbEnd; verb += 1) {
      const sourceOffset = provenanceOffset + verb * PROVENANCE_BYTES;
      const targetOffset = (verb - verbStart) * 3;
      provenance[targetOffset] = view.getUint32(sourceOffset, true);
      provenance[targetOffset + 1] = view.getUint32(sourceOffset + 4, true);
      provenance[targetOffset + 2] = view.getUint32(sourceOffset + 8, true);
    }
    validatePointArity(verbs, points.length);
    if (status === 'OK') {
      if (verbs.length === 0) throw new AbiContractError('OK output is empty');
      if (verbs.length > 65_536) {
        throw new AbiContractError('successful path exceeds the output verb limit');
      }
      validateOutputState(verbs);
      validateProvenance(verbs, points, provenance, source.verbs, source.points);
    } else if (status === 'EMPTY' && (source.verbs.length !== 0 || source.points.length !== 0)) {
      throw new AbiContractError('EMPTY output does not correspond to an empty input');
    }
    decoded.push({
      requestId,
      sourceEpoch,
      sourceRevision,
      status,
      bounds,
      verbs,
      points,
      provenance,
    });
    previousVerbEnd = verbEnd;
    previousPointEnd = pointEnd;
  }
  if (previousVerbEnd !== verbCount || previousPointEnd !== pointCount) {
    throw new AbiContractError('output ranges do not consume all published values');
  }
  return decoded;
}

export function readKernelWork(memory: WebAssembly.Memory, pointer: number): GeometryKernelWork {
  const buffer = memory.buffer;
  assertMemoryRange(buffer.byteLength, pointer, 48, 'statistics');
  if (pointer % 8 !== 0) throw new AbiContractError('statistics pointer is not 8-byte aligned');
  const view = new DataView(buffer, pointer, 48);
  return {
    logicalCubics: view.getBigUint64(0, true),
    sizingVisits: view.getBigUint64(8, true),
    emissionVisits: view.getBigUint64(16, true),
    emittedCubicLines: view.getBigUint64(24, true),
    attemptedPaths: view.getBigUint64(32, true),
    failedPaths: view.getBigUint64(40, true),
  };
}

export function assertKernelExports(value: unknown): asserts value is GeometryKernelExports {
  if (typeof value !== 'object' || value === null)
    throw new AbiContractError('WASM exports are absent');
  const exports = value as Partial<GeometryKernelExports>;
  if (!(exports.memory instanceof WebAssembly.Memory)) {
    throw new AbiContractError('WASM memory export is missing');
  }
  if (!(exports.memory.buffer instanceof ArrayBuffer)) {
    throw new AbiContractError('shared WASM memory violates the single-threaded ABI');
  }
  const functions: readonly (keyof GeometryKernelExports)[] = [
    'abi_version',
    'reserve',
    'input_ptr',
    'input_capacity',
    'output_ptr',
    'output_capacity',
    'memory_epoch',
    'process',
    'result_len',
    'required_output_bytes',
    'statistics_ptr',
    'dispose',
  ];
  for (const name of functions) {
    if (typeof exports[name] !== 'function')
      throw new AbiContractError(`WASM export ${name} is missing`);
  }
}

export function assertMemoryRange(
  memoryBytes: number,
  pointer: number,
  length: number,
  label: string,
): void {
  if (!isU32(pointer) || !isU32(length) || pointer + length > memoryBytes) {
    throw new AbiContractError(`${label} range is outside linear memory`);
  }
}

export function batchErrorCode(status: number): GeometryBatchErrorCode | null {
  switch (status) {
    case BATCH_STATUS.INVALID_BATCH:
      return 'INVALID_BATCH';
    case BATCH_STATUS.ALLOCATION_FAILED:
      return 'ALLOCATION_FAILED';
    case BATCH_STATUS.DISPOSED:
      return 'DISPOSED';
    case BATCH_STATUS.RESOURCE_LIMIT:
      return 'RESOURCE_LIMIT';
    case BATCH_STATUS.INTERNAL_ERROR:
      return 'INTERNAL_ERROR';
    default:
      return null;
  }
}

export function isU32(value: number): boolean {
  return Number.isInteger(value) && value >= 0 && value <= MAX_U32;
}

function decodePathStatus(value: number): DecodedPath['status'] {
  switch (value) {
    case PATH_STATUS.OK:
      return 'OK';
    case PATH_STATUS.EMPTY:
      return 'EMPTY';
    case PATH_STATUS.INVALID_PATH:
      return 'INVALID_PATH';
    case PATH_STATUS.INVALID_TOLERANCE:
      return 'INVALID_TOLERANCE';
    case PATH_STATUS.NUMERIC_RANGE:
      return 'NUMERIC_RANGE';
    case PATH_STATUS.WORK_LIMIT:
      return 'WORK_LIMIT';
    default:
      throw new AbiContractError(`unknown path status ${String(value)}`);
  }
}

function assertZero(bytes: Uint8Array, start: number, end: number, label: string): void {
  for (let index = start; index < end; index += 1) {
    if (bytes[index] !== 0) throw new AbiContractError(`${label} is nonzero`);
  }
}

function validatePointArity(verbs: Uint8Array, pointCount: number): void {
  let expected = 0;
  for (const verb of verbs) {
    expected += verb === 0 || verb === 1 ? 2 : 0;
  }
  if (expected !== pointCount)
    throw new AbiContractError('output verb/point arity is inconsistent');
}

function validateOutputState(verbs: Uint8Array): void {
  let open = false;
  for (const verb of verbs) {
    if (verb === 0) open = true;
    else if (verb === 1) {
      if (!open) throw new AbiContractError('output LINE has no open subpath');
    } else if (verb === 3) {
      if (!open) throw new AbiContractError('output CLOSE has no open subpath');
      open = false;
    }
  }
}

function validateProvenance(
  outputVerbs: Uint8Array,
  outputPoints: Float64Array,
  provenance: Uint32Array,
  sourceVerbs: Uint8Array,
  sourcePoints: Float64Array,
): void {
  let outputIndex = 0;
  let outputPointIndex = 0;
  let sourcePointIndex = 0;
  for (let sourceOrdinal = 0; sourceOrdinal < sourceVerbs.length; sourceOrdinal += 1) {
    const sourceVerb = sourceVerbs[sourceOrdinal];
    if (sourceVerb === undefined) throw new AbiContractError('source verb is absent');
    if (sourceVerb !== 2) {
      assertProvenanceTriplet(provenance, outputIndex, sourceOrdinal, 1, 0);
      if (outputVerbs[outputIndex] !== sourceVerb) {
        throw new AbiContractError('non-cubic output verb/provenance does not match its source');
      }
      if (sourceVerb === 0 || sourceVerb === 1) {
        if (
          !Object.is(outputPoints[outputPointIndex], sourcePoints[sourcePointIndex]) ||
          !Object.is(outputPoints[outputPointIndex + 1], sourcePoints[sourcePointIndex + 1])
        ) {
          throw new AbiContractError('copied MOVE/LINE coordinates differ from canonical input');
        }
        outputPointIndex += 2;
        sourcePointIndex += 2;
      }
      outputIndex += 1;
      continue;
    }

    const first = outputIndex;
    let cubicLineCount = 0;
    let previousNumerator = 0;
    let previousDenominator = 1;
    while (outputIndex < outputVerbs.length && provenance[outputIndex * 3] === sourceOrdinal) {
      if (outputVerbs[outputIndex] !== 1) {
        throw new AbiContractError('cubic provenance is attached to a non-LINE output');
      }
      const numerator = provenance[outputIndex * 3 + 1];
      const depth = provenance[outputIndex * 3 + 2];
      if (numerator === undefined || depth === undefined || depth > 20) {
        throw new AbiContractError('cubic provenance depth is invalid');
      }
      const denominator = 2 ** depth;
      const currentNumerator = numerator;
      if (currentNumerator === 0 || currentNumerator > denominator) {
        throw new AbiContractError('cubic provenance numerator is invalid');
      }
      if (previousNumerator * denominator !== (currentNumerator - 1) * previousDenominator) {
        throw new AbiContractError('cubic provenance intervals are not contiguous');
      }
      previousNumerator = currentNumerator;
      previousDenominator = denominator;
      outputIndex += 1;
      outputPointIndex += 2;
      cubicLineCount += 1;
      if (cubicLineCount > 8192) {
        throw new AbiContractError('cubic output exceeds the emitted-line limit');
      }
    }
    if (outputIndex === first || previousNumerator !== previousDenominator) {
      throw new AbiContractError('cubic provenance does not cover [0,1]');
    }
    sourcePointIndex += 6;
  }
  if (
    outputIndex !== outputVerbs.length ||
    outputPointIndex !== outputPoints.length ||
    sourcePointIndex !== sourcePoints.length
  ) {
    throw new AbiContractError('output has surplus provenance, verbs or points');
  }
}

function assertProvenanceTriplet(
  provenance: Uint32Array,
  outputIndex: number,
  sourceOrdinal: number,
  numerator: number,
  depth: number,
): void {
  const index = outputIndex * 3;
  if (
    provenance[index] !== sourceOrdinal ||
    provenance[index + 1] !== numerator ||
    provenance[index + 2] !== depth
  ) {
    throw new AbiContractError('non-cubic provenance is invalid');
  }
}
