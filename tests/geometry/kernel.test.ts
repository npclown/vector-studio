import { readFile } from 'node:fs/promises';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  generateP2GeometryCorpus,
  NAMED_CUBIC_FIXTURES,
  screenTolerance,
  validateContinuousCubicError,
  validateReferenceBounds,
  type ReferenceFlattenedLine,
} from '../../packages/geometry-reference/src/index.js';

type Kernel = {
  memory: WebAssembly.Memory;
  abi_version(): number;
  reserve(input: number, output: number): number;
  input_ptr(): number;
  input_capacity(): number;
  output_ptr(): number;
  output_capacity(): number;
  memory_epoch(): number;
  process(length: number): number;
  result_len(): number;
  required_output_bytes(): number;
  statistics_ptr(): number;
  dispose(): void;
};
type PathInput = {
  verbs: readonly number[];
  points: readonly number[];
  tolerance?: number;
};
type PathOutput = {
  requestId: number;
  sourceEpoch: number;
  sourceRevision: number;
  status: number;
  verbs: number[];
  points: number[];
  provenance: number[];
  bounds: { minX: number; minY: number; maxX: number; maxY: number };
};

const align = (value: number, alignment: number) => Math.ceil(value / alignment) * alignment;

// Test composition encodes the documented wire format without a production adapter.
function encode(paths: readonly PathInput[]): Uint8Array<ArrayBuffer> {
  const verbCount = paths.reduce((sum, value) => sum + value.verbs.length, 0);
  const pointCount = paths.reduce((sum, value) => sum + value.points.length, 0);
  const requests = 48;
  const pathOffsets = requests + paths.length * 24;
  const pointOffsets = pathOffsets + (paths.length + 1) * 4;
  const verbs = pointOffsets + (paths.length + 1) * 4;
  const points = align(verbs + verbCount, 8);
  const bytes = new Uint8Array(points + pointCount * 8);
  const view = new DataView(bytes.buffer);
  [
    0x32534756,
    1,
    bytes.length,
    paths.length,
    verbCount,
    pointCount,
    requests,
    pathOffsets,
    pointOffsets,
    verbs,
    points,
    0,
  ].forEach((value, index) => view.setUint32(index * 4, value, true));
  let verbIndex = 0;
  let pointIndex = 0;
  paths.forEach((value, index) => {
    const request = requests + index * 24;
    view.setUint32(request, 100 + index, true);
    view.setUint32(request + 4, 2, true);
    view.setUint32(request + 8, 17 + index, true);
    view.setFloat64(request + 16, value.tolerance ?? 0.25, true);
    view.setUint32(pathOffsets + index * 4, verbIndex, true);
    view.setUint32(pointOffsets + index * 4, pointIndex, true);
    for (const verb of value.verbs) bytes[verbs + verbIndex++] = verb;
    for (const point of value.points) view.setFloat64(points + pointIndex++ * 8, point, true);
  });
  view.setUint32(pathOffsets + paths.length * 4, verbIndex, true);
  view.setUint32(pointOffsets + paths.length * 4, pointIndex, true);
  return bytes;
}

function output(kernel: Kernel): PathOutput[] {
  const length = kernel.result_len() >>> 0;
  expect(length).toBeGreaterThanOrEqual(48);
  const pointer = kernel.output_ptr() >>> 0;
  const view = new DataView(kernel.memory.buffer, pointer, length);
  const u32 = (offset: number) => view.getUint32(offset, true);
  expect(u32(0)).toBe(0x32524756);
  expect(u32(4)).toBe(1);
  expect(u32(8)).toBe(length);
  const count = u32(12),
    verbCount = u32(16),
    pointCount = u32(20);
  const records = u32(24),
    verbs = u32(28),
    points = u32(32),
    provenance = u32(36);
  expect([u32(40), u32(44)]).toEqual([0, 0]);
  expect(records).toBe(48);
  expect(verbs).toBe(records + count * 64);
  expect(points).toBe(align(verbs + verbCount, 8));
  expect(provenance).toBe(points + pointCount * 8);
  expect(provenance + verbCount * 12).toBe(length);
  for (let index = verbs + verbCount; index < points; index++) expect(view.getUint8(index)).toBe(0);
  let priorVerb = 0,
    priorPoint = 0;
  const results = Array.from({ length: count }, (_, index) => {
    const offset = records + index * 64;
    const verbStart = u32(offset + 16),
      verbEnd = u32(offset + 20);
    const pointStart = u32(offset + 24),
      pointEnd = u32(offset + 28);
    expect(verbStart).toBe(priorVerb);
    expect(pointStart).toBe(priorPoint);
    expect(verbEnd).toBeGreaterThanOrEqual(verbStart);
    expect(verbEnd).toBeLessThanOrEqual(verbCount);
    expect(pointEnd).toBeGreaterThanOrEqual(pointStart);
    expect(pointEnd).toBeLessThanOrEqual(pointCount);
    priorVerb = verbEnd;
    priorPoint = pointEnd;
    const result = {
      requestId: u32(offset),
      sourceEpoch: u32(offset + 4),
      sourceRevision: u32(offset + 8),
      status: u32(offset + 12),
      verbs: Array.from({ length: verbEnd - verbStart }, (_, i) =>
        view.getUint8(verbs + verbStart + i),
      ),
      points: Array.from({ length: pointEnd - pointStart }, (_, i) =>
        view.getFloat64(points + (pointStart + i) * 8, true),
      ),
      provenance: Array.from({ length: (verbEnd - verbStart) * 3 }, (_, i) =>
        u32(provenance + (verbStart * 3 + i) * 4),
      ),
      bounds: {
        minX: view.getFloat64(offset + 32, true),
        minY: view.getFloat64(offset + 40, true),
        maxX: view.getFloat64(offset + 48, true),
        maxY: view.getFloat64(offset + 56, true),
      },
    };
    expect(result.status).toBeLessThanOrEqual(5);
    expect(result.verbs.every((verb) => verb === 0 || verb === 1 || verb === 3)).toBe(true);
    expect(result.points.length).toBe(
      result.verbs.reduce((sum, verb) => sum + (verb === 3 ? 0 : 2), 0),
    );
    expect(result.points.every(Number.isFinite)).toBe(true);
    expect(Object.values(result.bounds).every(Number.isFinite)).toBe(true);
    if (result.status !== 0) {
      expect(result.verbs).toEqual([]);
      expect(result.points).toEqual([]);
      expect(result.bounds).toEqual({ minX: 0, minY: 0, maxX: 0, maxY: 0 });
    } else {
      expect(result.bounds.minX).toBeLessThanOrEqual(result.bounds.maxX);
      expect(result.bounds.minY).toBeLessThanOrEqual(result.bounds.maxY);
    }
    return result;
  });
  expect(priorVerb).toBe(verbCount);
  expect(priorPoint).toBe(pointCount);
  return results;
}

function writeInput(kernel: Kernel, input: Uint8Array<ArrayBuffer>) {
  new Uint8Array(kernel.memory.buffer, kernel.input_ptr() >>> 0, input.length).set(input);
}

function processPaths(kernel: Kernel, paths: readonly PathInput[]): PathOutput[] {
  const input = encode(paths);
  expect(kernel.reserve(input.length, 256 * 1024)).toBe(0);
  writeInput(kernel, input);
  expect(kernel.process(input.length)).toBe(0);
  return output(kernel);
}

function counters(kernel: Kernel): bigint[] {
  const pointer = kernel.statistics_ptr() >>> 0;
  expect(pointer % 8).toBe(0);
  expect(pointer + 48).toBeLessThanOrEqual(kernel.memory.buffer.byteLength);
  const view = new DataView(kernel.memory.buffer, pointer, 48);
  return Array.from({ length: 6 }, (_, index) => view.getBigUint64(index * 8, true));
}

let module: WebAssembly.Module;
async function freshKernel(): Promise<Kernel> {
  const instance = await WebAssembly.instantiate(module, {});
  return instance.exports as unknown as Kernel;
}

beforeAll(async () => {
  const file = process.env.P2_WASM_PATH;
  if (!file) throw new Error('Run pnpm test:geometry to build and select the exact WASM artifact.');
  module = await WebAssembly.compile(new Uint8Array(await readFile(file)));
});

describe('P2 raw WASM contract without a production adapter', () => {
  it('has no host imports and exposes the declared v1 boundary', async () => {
    expect(WebAssembly.Module.imports(module)).toEqual([]);
    const kernel = await freshKernel();
    expect(kernel.abi_version()).toBe(1);
    for (const name of [
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
    ]) {
      expect(typeof kernel[name as keyof Kernel], name).toBe('function');
    }
    expect(processPaths(kernel, [])).toEqual([]);
    kernel.dispose();
  });

  it('echoes revisions and retains MOVE/LINE/CLOSE while isolating invalid paths', async () => {
    const kernel = await freshKernel();
    const results = processPaths(kernel, [
      { verbs: [], points: [] },
      { verbs: [1], points: [1, 1] },
      { verbs: [0, 1, 3, 0], points: [2, 3, 4, 5, -1, 9] },
      { verbs: [0], points: [Number.NaN, 0], tolerance: -1 },
      { verbs: [0], points: [0, 0], tolerance: -1 },
    ]);
    expect(results.map((value) => value.status)).toEqual([1, 2, 0, 2, 3]);
    results.forEach((value, index) =>
      expect([value.requestId, value.sourceEpoch, value.sourceRevision]).toEqual([
        100 + index,
        2,
        17 + index,
      ]),
    );
    expect(results[2]?.verbs).toEqual([0, 1, 3, 0]);
    expect(results[2]?.points).toEqual([2, 3, 4, 5, -1, 9]);
    expect(results[2]?.provenance).toEqual([0, 1, 0, 1, 1, 0, 2, 1, 0, 3, 1, 0]);
    expect(results[2]?.bounds).toEqual({ minX: -1, minY: 3, maxX: 4, maxY: 9 });
    for (const index of [0, 1, 3, 4]) {
      expect(results[index]?.points).toEqual([]);
      expect(results[index]?.verbs).toEqual([]);
      expect(results[index]?.bounds).toEqual({ minX: 0, minY: 0, maxX: 0, maxY: 0 });
    }
    kernel.dispose();
  });

  it('rejects malformed envelopes before work and never publishes an old result', async () => {
    const kernel = await freshKernel();
    processPaths(kernel, [{ verbs: [0], points: [0, 0] }]);
    for (const [offset, value] of [
      [0, 0],
      [4, 2],
      [8, 0],
      [12, 0xffffffff],
      [24, 49],
      [28, 48],
      [32, 0xfffffff0],
      [36, 80],
      [40, 97],
      [44, 1],
      [60, 1],
      [72, 1],
      [76, 0],
      [84, 1],
      [89, 1],
    ]) {
      const input = encode([{ verbs: [0], points: [0, 0] }]);
      new DataView(input.buffer).setUint32(offset!, value!, true);
      writeInput(kernel, input);
      expect(kernel.process(input.length)).toBe(1);
      expect(kernel.result_len()).toBe(0);
      expect(kernel.required_output_bytes()).toBe(0);
      expect(counters(kernel)).toEqual([0n, 0n, 0n, 0n, 0n, 0n]);
    }
    const original = encode([{ verbs: [0], points: [0, 0] }]);
    const trailing = new Uint8Array(original.length + 8);
    trailing.set(original);
    new DataView(trailing.buffer).setUint32(8, trailing.length, true);
    expect(kernel.reserve(trailing.length, 256 * 1024)).toBe(0);
    writeInput(kernel, trailing);
    expect(kernel.process(trailing.length)).toBe(1);
    expect(kernel.result_len()).toBe(0);
    expect(counters(kernel)).toEqual([0n, 0n, 0n, 0n, 0n, 0n]);
    kernel.dispose();
  });

  it('requires explicit output reservation and invalidates views/epochs across growth and disposal', async () => {
    const kernel = await freshKernel();
    const input = encode([{ verbs: [0, 1], points: [0, 0, 3, 2] }]);
    expect(kernel.reserve(input.length, 0)).toBe(0);
    const initialEpoch = kernel.memory_epoch();
    writeInput(kernel, input);
    expect(kernel.process(input.length)).toBe(2);
    expect(kernel.memory_epoch()).toBe(initialEpoch + 1);
    expect(kernel.result_len()).toBe(0);
    const required = kernel.required_output_bytes() >>> 0;
    expect(required).toBeGreaterThan(48);
    expect(kernel.reserve(input.length, required)).toBe(0);
    // The caller retains its copy and refreshes pointers after reserve.
    writeInput(kernel, input);
    expect(kernel.process(input.length)).toBe(0);
    expect(kernel.result_len()).toBe(required);
    const retained = output(kernel);
    const stableBuffer = kernel.memory.buffer;
    const stableEpoch = kernel.memory_epoch();
    expect(kernel.reserve(input.length, required)).toBe(0);
    expect(kernel.memory.buffer).toBe(stableBuffer);
    expect(kernel.memory_epoch()).toBe(stableEpoch + 1);
    expect(kernel.result_len()).toBe(0);
    writeInput(kernel, input);
    expect(kernel.process(input.length)).toBe(0);
    expect(kernel.memory_epoch()).toBe(stableEpoch + 2);
    const oldBuffer = kernel.memory.buffer;
    const oldEpoch = kernel.memory_epoch();
    const largerThanMemory = oldBuffer.byteLength + 65536;
    expect(largerThanMemory).toBeLessThan(64 * 1024 * 1024);
    expect(kernel.reserve(largerThanMemory, required)).toBe(0);
    expect(kernel.memory_epoch()).toBe(oldEpoch + 1);
    expect(kernel.memory.buffer).not.toBe(oldBuffer);
    expect(oldBuffer.byteLength).toBe(0);
    expect(retained[0]?.points).toEqual([0, 0, 3, 2]);
    expect(kernel.reserve(64 * 1024 * 1024 + 1, 0)).toBe(5);
    expect(kernel.reserve(0, 256 * 1024 * 1024 + 1)).toBe(5);
    expect(kernel.memory_epoch()).toBe(oldEpoch + 3);
    expect(kernel.result_len()).toBe(0);
    kernel.dispose();
    expect(kernel.memory_epoch()).toBe(oldEpoch + 4);
    kernel.dispose();
    expect(kernel.memory_epoch()).toBe(oldEpoch + 5);
    expect(kernel.process(input.length)).toBe(4);
    expect(kernel.reserve(input.length, required)).toBe(4);
    expect(kernel.result_len()).toBe(0);
    const replacement = await freshKernel();
    expect(processPaths(replacement, [{ verbs: [0], points: [8, 9] }])[0]?.status).toBe(0);
    replacement.dispose();
  });

  it('publishes named numerical failures atomically and preserves a following valid path', async () => {
    const kernel = await freshKernel();
    for (const fixture of NAMED_CUBIC_FIXTURES) {
      const results = processPaths(kernel, [
        { verbs: [0, 2], points: fixture.cubic.flat() },
        { verbs: [0, 1], points: [8, 9, 10, 11] },
      ]);
      expect(results[1]?.status, fixture.name).toBe(0);
      const result = results[0]!;
      if (fixture.expectation === 'numeric-range') {
        expect(result.status, fixture.name).toBe(4);
      } else {
        expect(result.status, fixture.name).toBe(0);
        expect(validateReferenceBounds(fixture.cubic, result.bounds).ok, fixture.name).toBe(true);
        const lines: ReferenceFlattenedLine[] = result.verbs.slice(1).map((_, index) => ({
          end: [result.points[(index + 1) * 2]!, result.points[(index + 1) * 2 + 1]!],
          provenance: {
            sourceVerbOrdinal: result.provenance[(index + 1) * 3]!,
            endNumerator: result.provenance[(index + 1) * 3 + 1]!,
            depth: result.provenance[(index + 1) * 3 + 2]!,
          },
        }));
        expect(
          validateContinuousCubicError(fixture.cubic, lines, [1, 0, 0, 1], 1).ok,
          fixture.name,
        ).toBe(true);
      }
    }
    const tooMany = 65_537;
    const failed = processPaths(kernel, [
      {
        verbs: Array.from({ length: tooMany }, () => 0),
        points: Array.from({ length: tooMany * 2 }, () => 0),
      },
      { verbs: [0], points: [7, 8] },
    ]);
    expect(failed.map((result) => result.status)).toEqual([5, 0]);
    kernel.dispose();
  });

  it('agrees with the independent oracle on every frozen seeded cubic in Node WASM', async () => {
    const kernel = await freshKernel();
    let verified = 0;
    for (const fixture of generateP2GeometryCorpus()) {
      const input = encode([
        { verbs: [0, 2], points: fixture.cubic.flat(), tolerance: fixture.bucketTolerance },
      ]);
      expect(kernel.reserve(input.length, 256 * 1024)).toBe(0);
      writeInput(kernel, input);
      const memory = kernel.memory.buffer;
      expect(kernel.process(input.length), `batch ${fixture.index}`).toBe(0);
      expect(kernel.memory.buffer).toBe(memory);
      const result = output(kernel)[0]!;
      expect(result.status, JSON.stringify(fixture)).toBe(0);
      expect(result.verbs[0]).toBe(0);
      expect(result.verbs.slice(1).every((value) => value === 1)).toBe(true);
      expect(result.points.slice(0, 2)).toEqual(fixture.cubic[0]);
      const bounds = validateReferenceBounds(fixture.cubic, result.bounds);
      expect(bounds.ok, `bounds ${fixture.index}: ${bounds.findings.join(', ')}`).toBe(true);
      const lines: ReferenceFlattenedLine[] = result.verbs.slice(1).map((_, index) => ({
        end: [result.points[(index + 1) * 2]!, result.points[(index + 1) * 2 + 1]!],
        provenance: {
          sourceVerbOrdinal: result.provenance[(index + 1) * 3]!,
          endNumerator: result.provenance[(index + 1) * 3 + 1]!,
          depth: result.provenance[(index + 1) * 3 + 2]!,
        },
      }));
      const tolerance = screenTolerance(fixture.world, fixture.zoom, fixture.dpr);
      if (!tolerance.ok) throw new Error(tolerance.finding);
      const error = validateContinuousCubicError(fixture.cubic, lines, tolerance.screen, 1);
      expect(error.ok, `curve ${fixture.index}: ${error.findings.join(', ')}`).toBe(true);
      const work = counters(kernel);
      expect(work[0]).toBe(1n);
      expect(work[1]).toBeGreaterThan(0n);
      expect(work[2]).toBe(work[1]);
      expect(work[3]).toBe(BigInt(lines.length));
      expect(work[4]).toBe(1n);
      expect(work[5]).toBe(0n);
      verified++;
    }
    expect(verified).toBe(10_000);
    kernel.dispose();
  });
});
