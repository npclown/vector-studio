import {
  BATCH_STATUS,
  GeometrySession,
  type GeometryBatchResult,
  type GeometryKernelExports,
  type GeometryRequest,
  type GeometryResult,
  type GeometrySessionStatistics,
} from '../../packages/geometry-wasm/src/index.js';

import type { P2KernelCalls, P2SessionCounters, P2VariantSample, P2WorkCounter } from './types.js';

class DualHash {
  private first = 0x811c_9dc5;
  private second = 0x9e37_79b9;
  private readonly scratch = new DataView(new ArrayBuffer(8));

  byte(value: number): void {
    const byte = value & 0xff;
    this.first = Math.imul(this.first ^ byte, 0x0100_0193) >>> 0;
    this.second = Math.imul(this.second ^ byte, 0x85eb_ca6b) >>> 0;
    this.second = ((this.second << 13) | (this.second >>> 19)) >>> 0;
  }

  text(value: string): void {
    const bytes = new TextEncoder().encode(value);
    this.u32(bytes.byteLength);
    for (const byte of bytes) this.byte(byte);
  }

  u32(value: number): void {
    this.scratch.setUint32(0, value >>> 0, true);
    for (let offset = 0; offset < 4; offset += 1) this.byte(this.scratch.getUint8(offset));
  }

  f64(value: number): void {
    this.scratch.setFloat64(0, value, true);
    for (let offset = 0; offset < 8; offset += 1) this.byte(this.scratch.getUint8(offset));
  }

  finish(): string {
    return `${this.first.toString(16).padStart(8, '0')}${this.second.toString(16).padStart(8, '0')}`;
  }
}

function hashResult(hash: DualHash, result: GeometryResult): number {
  hash.u32(result.requestId);
  hash.u32(result.sourceEpoch);
  hash.u32(result.sourceRevision);
  hash.text(result.status);
  if ('error' in result) {
    hash.text(result.error.code);
    hash.text(result.error.message);
    return 0;
  }
  hash.f64(result.bounds.minX);
  hash.f64(result.bounds.minY);
  hash.f64(result.bounds.maxX);
  hash.f64(result.bounds.maxY);
  hash.u32(result.verbs.length);
  for (const verb of result.verbs) hash.byte(verb);
  hash.u32(result.points.length);
  for (const point of result.points) hash.f64(point);
  hash.u32(result.provenance.length);
  for (const scalar of result.provenance) hash.u32(scalar);
  return result.verbs.byteLength + result.points.byteLength + result.provenance.byteLength;
}

export interface ChecksumSummary {
  readonly checksum: string;
  readonly resultCount: number;
  readonly copiedPayloadBytes: number;
  readonly peakRetainedPayloadBytes: number;
  readonly batchStatuses: readonly string[];
  readonly pathStatuses: Readonly<Record<string, number>>;
}

class ResultChecksum {
  private readonly hash = new DualHash();
  private resultCount = 0;
  private copiedPayloadBytes = 0;
  private peakRetainedPayloadBytes = 0;
  private readonly batchStatuses: string[] = [];
  private readonly pathStatuses = new Map<string, number>();

  constructor() {
    this.hash.text('p2-batch-result/v1');
  }

  add(batch: GeometryBatchResult): void {
    if (batch.status === 'BATCH_ERROR') {
      this.batchStatuses.push(`BATCH_ERROR:${batch.error.code}`);
      this.hash.text('BATCH_ERROR');
      this.hash.text(batch.error.code);
      this.hash.text(batch.error.message);
      return;
    }
    this.batchStatuses.push(batch.status);
    let retainedInBatch = 0;
    for (const result of batch.results) {
      this.resultCount += 1;
      this.pathStatuses.set(result.status, (this.pathStatuses.get(result.status) ?? 0) + 1);
      const bytes = hashResult(this.hash, result);
      this.copiedPayloadBytes += bytes;
      retainedInBatch += bytes;
    }
    this.peakRetainedPayloadBytes = Math.max(this.peakRetainedPayloadBytes, retainedInBatch);
  }

  finish(): ChecksumSummary {
    this.hash.u32(this.resultCount);
    return {
      checksum: this.hash.finish(),
      resultCount: this.resultCount,
      copiedPayloadBytes: this.copiedPayloadBytes,
      peakRetainedPayloadBytes: this.peakRetainedPayloadBytes,
      batchStatuses: [...this.batchStatuses],
      pathStatuses: Object.fromEntries(
        [...this.pathStatuses].sort(([left], [right]) => left.localeCompare(right)),
      ),
    };
  }
}

export function checksumBatchResults(batches: readonly GeometryBatchResult[]): ChecksumSummary {
  const checksum = new ResultChecksum();
  for (const batch of batches) checksum.add(batch);
  return checksum.finish();
}

function work(values: GeometrySessionStatistics['kernelWork']): P2WorkCounter {
  return {
    logicalCubics: values.logicalCubics.toString(),
    sizingVisits: values.sizingVisits.toString(),
    emissionVisits: values.emissionVisits.toString(),
    emittedCubicLines: values.emittedCubicLines.toString(),
    attemptedPaths: values.attemptedPaths.toString(),
    failedPaths: values.failedPaths.toString(),
  };
}

export function sessionCounters(statistics: GeometrySessionStatistics): P2SessionCounters {
  return {
    hits: statistics.hits,
    misses: statistics.misses,
    kernelPathBuilds: statistics.kernelPathBuilds,
    evictions: statistics.evictions,
    retainedPayloadBytes: statistics.retainedPayloadBytes,
    liveLinearMemoryBytes: statistics.liveLinearMemoryBytes,
    residentNodes: statistics.residentNodes,
    variantEntries: statistics.variantEntries,
    kernelWork: work(statistics.kernelWork),
  };
}

function workDelta(
  after: GeometrySessionStatistics,
  before: GeometrySessionStatistics,
): P2WorkCounter {
  return {
    logicalCubics: (after.kernelWork.logicalCubics - before.kernelWork.logicalCubics).toString(),
    sizingVisits: (after.kernelWork.sizingVisits - before.kernelWork.sizingVisits).toString(),
    emissionVisits: (after.kernelWork.emissionVisits - before.kernelWork.emissionVisits).toString(),
    emittedCubicLines: (
      after.kernelWork.emittedCubicLines - before.kernelWork.emittedCubicLines
    ).toString(),
    attemptedPaths: (after.kernelWork.attemptedPaths - before.kernelWork.attemptedPaths).toString(),
    failedPaths: (after.kernelWork.failedPaths - before.kernelWork.failedPaths).toString(),
  };
}

export interface KernelObserver {
  readonly kernel: GeometryKernelExports;
  snapshot(): P2KernelCalls;
  reserveDurationMs(): number;
}

export function observeKernel(source: GeometryKernelExports): KernelObserver {
  const reserveStatuses: number[] = [];
  const processStatuses: number[] = [];
  const disposeStatuses: number[] = [];
  let growths = 0;
  let reserveDuration = 0;
  let sizingPasses = 0;
  let emissionPasses = 0;
  const observe = (statuses: number[], call: () => number): number => {
    const before = source.memory.buffer.byteLength;
    const status = call() >>> 0;
    if (source.memory.buffer.byteLength > before) growths += 1;
    statuses.push(status);
    return status;
  };
  const kernel: GeometryKernelExports = {
    ...source,
    reserve: (inputBytes, outputBytes) => {
      const start = performance.now();
      const status = observe(reserveStatuses, () => source.reserve(inputBytes, outputBytes));
      reserveDuration += performance.now() - start;
      return status;
    },
    process: (inputLength) => {
      const status = observe(processStatuses, () => source.process(inputLength));
      if (status === BATCH_STATUS.OK || status === BATCH_STATUS.OUTPUT_CAPACITY) sizingPasses += 1;
      if (status === BATCH_STATUS.OK) emissionPasses += 1;
      return status;
    },
    dispose: () => observe(disposeStatuses, () => source.dispose()),
  };
  return {
    kernel,
    snapshot: () => ({
      reserveStatuses: [...reserveStatuses],
      processStatuses: [...processStatuses],
      disposeStatuses: [...disposeStatuses],
      growths,
      sizingPasses,
      emissionPasses,
    }),
    reserveDurationMs: () => reserveDuration,
  };
}

function callsDelta(after: P2KernelCalls, before: P2KernelCalls): P2KernelCalls {
  return {
    reserveStatuses: after.reserveStatuses.slice(before.reserveStatuses.length),
    processStatuses: after.processStatuses.slice(before.processStatuses.length),
    disposeStatuses: after.disposeStatuses.slice(before.disposeStatuses.length),
    growths: after.growths - before.growths,
    sizingPasses: after.sizingPasses - before.sizingPasses,
    emissionPasses: after.emissionPasses - before.emissionPasses,
  };
}

export function measureVariant(
  variant: 'batch' | 'per-path',
  session: GeometrySession,
  observer: KernelObserver,
  requests: readonly GeometryRequest[],
): P2VariantSample {
  const statisticsBeforeRaw = session.snapshotStatistics();
  const callsBefore = observer.snapshot();
  const errors: string[] = [];
  const checksum = new ResultChecksum();
  const startMs = performance.now();
  try {
    if (variant === 'batch') {
      checksum.add(session.batch(requests));
    } else {
      for (const request of requests) checksum.add(session.batch([request]));
    }
  } catch (error) {
    errors.push(error instanceof Error ? `${error.name}: ${error.message}` : String(error));
  }
  const checked = checksum.finish();
  const endMs = performance.now();
  for (const status of checked.batchStatuses) {
    if (status !== 'OK') errors.push(`batch status ${status}`);
  }
  for (const [status, count] of Object.entries(checked.pathStatuses)) {
    if (status !== 'OK') errors.push(`${count} path result(s) had status ${status}`);
  }
  const statisticsAfterRaw = session.snapshotStatistics();
  const callsAfter = observer.snapshot();
  return {
    variant,
    timing: { startMs, endMs, durationMs: endMs - startMs },
    batchStatuses: checked.batchStatuses,
    pathStatuses: checked.pathStatuses,
    checksum: checked.checksum,
    resultCount: checked.resultCount,
    copiedPayloadBytes: checked.copiedPayloadBytes,
    peakRetainedPayloadBytes: checked.peakRetainedPayloadBytes,
    calls: callsDelta(callsAfter, callsBefore),
    statisticsBefore: sessionCounters(statisticsBeforeRaw),
    statisticsAfter: sessionCounters(statisticsAfterRaw),
    work: workDelta(statisticsAfterRaw, statisticsBeforeRaw),
    errors,
  };
}
