import { describe, expect, it, vi } from 'vitest';
import {
  GeometrySession,
  type GeometryKernelExports,
  type GeometryRequest,
} from '../../packages/geometry-wasm/src/index.js';

const INPUT_POINTER = 0;
const OUTPUT_POINTER = 128 * 1024;
const STATISTICS_POINTER = 240 * 1024;

function request(domainId: string, nodeId: string, revision = 1): GeometryRequest {
  return {
    domainId,
    nodeId,
    requestId: 7,
    sourceEpoch: 1,
    sourceRevision: revision,
    verbs: new Uint8Array([0]),
    points: new Float64Array([3, 4]),
    strokeStyleHash: 'style',
    fillRule: 'nonzero',
    world: [1, 0, 0, 1],
    zoom: 1,
    devicePixelRatio: 1,
  };
}

function successful(session: GeometrySession, requests: readonly GeometryRequest[]) {
  const result = session.batch(requests);
  if (result.status !== 'OK') throw new Error(result.error.message);
  return result.results;
}

describe('private geometry adapter cache', () => {
  it('keeps opaque identities collision-safe and isolates cached/caller arrays', () => {
    const session = new GeometrySession(fakeKernel());
    const first = request('a/b', 'c');
    const second = request('a', 'b/c');
    const built = successful(session, [first, second]);
    expect(built.map((result) => result.status)).toEqual(['OK', 'OK']);
    expect(session.snapshotStatistics()).toMatchObject({
      misses: 2,
      residentNodes: 2,
      variantEntries: 2,
      kernelPathBuilds: 4,
    });
    const firstResult = built[0];
    if (firstResult?.status !== 'OK') throw new Error('expected geometry');
    firstResult.points[0] = 999;
    first.points[0] = 9;
    expect(successful(session, [first])[0]?.status).toBe('REVISION_CONFLICT');
    const hit = successful(session, [{ ...request('a/b', 'c'), requestId: 99 }])[0];
    expect(hit).toMatchObject({ status: 'OK', requestId: 99 });
    if (hit?.status !== 'OK') throw new Error('expected geometry');
    expect(Array.from(hit.points)).toEqual([3, 4]);
    expect(session.snapshotStatistics().hits).toBe(1);
  });

  it('evicts whole least-recently-used nodes under reduced test limits', () => {
    const session = new GeometrySession(fakeKernel(), {
      cache: { maxNodes: 2, maxVariants: 2, maxPayloadBytes: 1024 },
    });
    successful(session, [request('d', 'one'), request('d', 'two')]);
    successful(session, [request('d', 'one')]);
    successful(session, [request('d', 'three')]);
    expect(session.snapshotStatistics()).toMatchObject({
      residentNodes: 2,
      variantEntries: 2,
      evictions: 1,
    });
    const builds = session.snapshotStatistics().kernelPathBuilds;
    successful(session, [request('d', 'two')]);
    expect(session.snapshotStatistics().kernelPathBuilds).toBe(builds + 1);
  });

  it('guards u32 source tokens and makes disposal terminal', () => {
    const session = new GeometrySession(fakeKernel());
    expect(session.batch([{ ...request('d', 'n'), sourceRevision: 0x1_0000_0000 }])).toMatchObject({
      status: 'BATCH_ERROR',
      error: { code: 'INVALID_REQUEST' },
    });
    session.dispose();
    session.dispose();
    expect(session.snapshotStatistics()).toMatchObject({
      retainedPayloadBytes: 0,
      residentNodes: 0,
      variantEntries: 0,
    });
    expect(session.batch([request('d', 'n')])).toMatchObject({
      status: 'BATCH_ERROR',
      error: { code: 'DISPOSED' },
    });
  });

  it('rejects shared caller storage before retaining a revision', () => {
    const session = new GeometrySession(fakeKernel());
    const shared = new Float64Array(new SharedArrayBuffer(16));
    expect(session.batch([{ ...request('d', 'shared'), points: shared }])).toMatchObject({
      status: 'BATCH_ERROR',
      error: { code: 'INVALID_REQUEST' },
    });
    expect(session.snapshotStatistics()).toMatchObject({
      residentNodes: 0,
      retainedPayloadBytes: 0,
      kernelPathBuilds: 0,
    });
  });

  it('fails closed when a resource failure violates its zero-result postconditions', () => {
    const session = new GeometrySession(fakeKernel({ corruptResourceRequirement: true }));
    expect(session.batch([request('d', 'n')])).toMatchObject({
      status: 'BATCH_ERROR',
      error: { code: 'ABI_CONTRACT' },
    });
    expect(session.snapshotStatistics()).toMatchObject({
      residentNodes: 0,
      retainedPayloadBytes: 0,
      liveLinearMemoryBytes: 0,
    });
    expect(session.batch([request('d', 'n')])).toMatchObject({
      status: 'BATCH_ERROR',
      error: { code: 'DISPOSED' },
    });
  });

  it('maps a below-cap decoder copy failure without leaking partial output', () => {
    const session = new GeometrySession(fakeKernel(), { cache: { maxPayloadBytes: 0 } });
    const slice = vi.spyOn(Uint8Array.prototype, 'slice').mockImplementationOnce(() => {
      throw new RangeError('injected typed-array allocation failure');
    });
    try {
      expect(session.batch([request('d', 'copy-failure')])).toMatchObject({
        status: 'BATCH_ERROR',
        error: { code: 'ALLOCATION_FAILED' },
      });
    } finally {
      slice.mockRestore();
    }
    expect(session.snapshotStatistics()).toMatchObject({
      residentNodes: 0,
      variantEntries: 0,
      retainedPayloadBytes: 0,
    });
    expect(successful(session, [request('d', 'copy-failure')])[0]?.status).toBe('OK');
  });
});

function fakeKernel(
  options: { readonly corruptResourceRequirement?: boolean } = {},
): GeometryKernelExports {
  const memory = new WebAssembly.Memory({ initial: 4 });
  let epoch = 0;
  let inputCapacity = 0;
  let outputCapacity = 0;
  let resultLength = 0;
  let requiredOutputBytes = 0;
  let disposed = false;

  const mutate = () => {
    epoch += 1;
    resultLength = 0;
    requiredOutputBytes = 0;
  };
  return {
    memory,
    abi_version: () => 1,
    reserve(inputBytes, outputBytes) {
      mutate();
      if (disposed) return 4;
      if (options.corruptResourceRequirement === true) {
        requiredOutputBytes = 8;
        return 5;
      }
      inputCapacity = Math.max(inputCapacity, inputBytes);
      outputCapacity = Math.max(outputCapacity, outputBytes);
      return 0;
    },
    input_ptr: () => INPUT_POINTER,
    input_capacity: () => inputCapacity,
    output_ptr: () => OUTPUT_POINTER,
    output_capacity: () => outputCapacity,
    memory_epoch: () => epoch,
    process(inputLength) {
      mutate();
      if (disposed) return 4;
      const input = new DataView(memory.buffer, INPUT_POINTER, inputLength);
      const pathCount = input.getUint32(12, true);
      const requestsOffset = input.getUint32(24, true);
      const pathOffsetsOffset = input.getUint32(28, true);
      const pointOffsetsOffset = input.getUint32(32, true);
      const verbsOffset = input.getUint32(36, true);
      const pointsOffset = input.getUint32(40, true);
      const verbCount = input.getUint32(16, true);
      const pointCount = input.getUint32(20, true);
      const resultsOffset = 48;
      const outputVerbsOffset = resultsOffset + pathCount * 64;
      const outputPointsOffset = align(outputVerbsOffset + verbCount, 8);
      const provenanceOffset = align(outputPointsOffset + pointCount * 8, 4);
      requiredOutputBytes = provenanceOffset + verbCount * 12;
      writeStatistics(memory, pathCount);
      if (requiredOutputBytes > outputCapacity) return 2;
      const outputBytes = new Uint8Array(memory.buffer, OUTPUT_POINTER, requiredOutputBytes);
      outputBytes.fill(0);
      const output = new DataView(memory.buffer, OUTPUT_POINTER, requiredOutputBytes);
      const header = [
        0x3252_4756,
        1,
        requiredOutputBytes,
        pathCount,
        verbCount,
        pointCount,
        resultsOffset,
        outputVerbsOffset,
        outputPointsOffset,
        provenanceOffset,
        0,
        0,
      ];
      header.forEach((value, index) => output.setUint32(index * 4, value, true));
      new Uint8Array(memory.buffer, OUTPUT_POINTER + outputVerbsOffset, verbCount).set(
        new Uint8Array(memory.buffer, INPUT_POINTER + verbsOffset, verbCount),
      );
      for (let scalar = 0; scalar < pointCount; scalar += 1) {
        output.setFloat64(
          outputPointsOffset + scalar * 8,
          input.getFloat64(pointsOffset + scalar * 8, true),
          true,
        );
      }
      for (let index = 0; index < pathCount; index += 1) {
        const requestOffset = requestsOffset + index * 24;
        const resultOffset = resultsOffset + index * 64;
        const verbStart = input.getUint32(pathOffsetsOffset + index * 4, true);
        const verbEnd = input.getUint32(pathOffsetsOffset + (index + 1) * 4, true);
        const pointStart = input.getUint32(pointOffsetsOffset + index * 4, true);
        const pointEnd = input.getUint32(pointOffsetsOffset + (index + 1) * 4, true);
        output.setUint32(resultOffset, input.getUint32(requestOffset, true), true);
        output.setUint32(resultOffset + 4, input.getUint32(requestOffset + 4, true), true);
        output.setUint32(resultOffset + 8, input.getUint32(requestOffset + 8, true), true);
        output.setUint32(resultOffset + 12, verbEnd === verbStart ? 1 : 0, true);
        output.setUint32(resultOffset + 16, verbStart, true);
        output.setUint32(resultOffset + 20, verbEnd, true);
        output.setUint32(resultOffset + 24, pointStart, true);
        output.setUint32(resultOffset + 28, pointEnd, true);
        if (verbEnd !== verbStart) {
          const x = input.getFloat64(pointsOffset + pointStart * 8, true);
          const y = input.getFloat64(pointsOffset + (pointStart + 1) * 8, true);
          output.setFloat64(resultOffset + 32, x, true);
          output.setFloat64(resultOffset + 40, y, true);
          output.setFloat64(resultOffset + 48, x, true);
          output.setFloat64(resultOffset + 56, y, true);
        }
        for (let verb = verbStart; verb < verbEnd; verb += 1) {
          output.setUint32(provenanceOffset + verb * 12, verb - verbStart, true);
          output.setUint32(provenanceOffset + verb * 12 + 4, 1, true);
          output.setUint32(provenanceOffset + verb * 12 + 8, 0, true);
        }
      }
      resultLength = requiredOutputBytes;
      return 0;
    },
    result_len: () => resultLength,
    required_output_bytes: () => requiredOutputBytes,
    statistics_ptr: () => STATISTICS_POINTER,
    dispose() {
      mutate();
      disposed = true;
      inputCapacity = 0;
      outputCapacity = 0;
      return 0;
    },
  };
}

function writeStatistics(memory: WebAssembly.Memory, attemptedPaths: number): void {
  const view = new DataView(memory.buffer, STATISTICS_POINTER, 48);
  for (let offset = 0; offset < 48; offset += 8) view.setBigUint64(offset, 0n, true);
  view.setBigUint64(32, BigInt(attemptedPaths), true);
}

function align(value: number, alignment: number): number {
  return Math.ceil(value / alignment) * alignment;
}
