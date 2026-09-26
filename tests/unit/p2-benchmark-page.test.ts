import { describe, expect, it } from 'vitest';

import type {
  GeometryBatchResult,
  GeometrySuccessResult,
} from '../../packages/geometry-wasm/src/index.js';
import { checksumBatchResults } from '../geometry-benchmark/measure.js';
import { P2_CACHE, P2_PROFILES, p2PairOrder } from '../geometry-benchmark/types.js';
import {
  createP2WorkloadFixture,
  P2_DEVICE_PIXEL_RATIO,
  P2_LOCAL_TOLERANCE,
  P2_SCENARIO,
  P2_WORKLOAD_CUBICS_PER_PATH,
  P2_WORKLOAD_CUBIC_COUNT,
  P2_WORKLOAD_PATHS,
  P2_WORKLOAD_SEED,
  P2_WORLD,
  P2_ZOOM,
} from '../geometry-benchmark/workload.js';

function success(overrides: Partial<GeometrySuccessResult> = {}): GeometrySuccessResult {
  return {
    requestId: 1,
    sourceEpoch: 2,
    sourceRevision: 3,
    status: 'OK',
    bounds: { minX: -4, minY: -3, maxX: 8, maxY: 9 },
    verbs: new Uint8Array([0, 1]),
    points: new Float64Array([1.25, -2.5, 3.75, 4.5]),
    provenance: new Uint32Array([0, 1, 0, 1, 1, 2]),
    ...overrides,
  };
}

function checksum(result: GeometrySuccessResult): string {
  return checksumBatchResults([{ status: 'OK', results: [result] }]).checksum;
}

describe('P2 frozen browser benchmark workload', () => {
  it('uses the accepted first xorshift32 draws as independent endpoint-relative deltas', () => {
    const workload = createP2WorkloadFixture(2, 1);
    const first = workload.requests[0];
    const second = workload.requests[1];
    expect(first?.points).toEqual(
      new Float64Array([
        0, 0, 5.933697754517198, -83.31560329534113, -43.64942591637373, 1.3295721262693405,
        -12.322908267378807, -67.45335697196424,
      ]),
    );
    expect(second?.points).toEqual(
      new Float64Array([
        0, 0, 7.648648181930184, 53.98080539889634, 65.2111369650811, -54.14644400589168,
        -17.385125532746315, -39.01627101004124,
      ]),
    );
    expect(first?.verbs).toEqual(new Uint8Array([0, 2]));
    expect(second?.requestId).toBe(2);
  });

  it('retains the frozen scenario metadata and profiles', () => {
    expect({
      scenario: P2_SCENARIO,
      seed: P2_WORKLOAD_SEED,
      paths: P2_WORKLOAD_PATHS,
      cubicsPerPath: P2_WORKLOAD_CUBICS_PER_PATH,
      inputCubics: P2_WORKLOAD_CUBIC_COUNT,
      localTolerance: P2_LOCAL_TOLERANCE,
      world: P2_WORLD,
      zoom: P2_ZOOM,
      devicePixelRatio: P2_DEVICE_PIXEL_RATIO,
      cache: P2_CACHE,
    }).toEqual({
      scenario: 'p2-batch/v1',
      seed: 0x1234_5678,
      paths: 1_000,
      cubicsPerPath: 32,
      inputCubics: 32_000,
      localTolerance: 0.25,
      world: [1, 0, 0, 1],
      zoom: 1,
      devicePixelRatio: 1,
      cache: { maxVariants: 0, maxNodes: 0, maxPayloadBytes: 0 },
    });
    expect(P2_PROFILES.functional).toEqual({
      name: 'functional',
      warmupPairs: 1,
      measuredPairs: 2,
      repetitions: 1,
    });
    expect(P2_PROFILES.reference).toEqual({
      name: 'reference',
      warmupPairs: 10,
      measuredPairs: 30,
      repetitions: 5,
    });
  });

  it('alternates AB/BA by zero-based pair index and one-based repetition in every phase', () => {
    expect([0, 1, 2, 3].map((index) => p2PairOrder(index, 1))).toEqual(['AB', 'BA', 'AB', 'BA']);
    expect([0, 1, 2, 3].map((index) => p2PairOrder(index, 2))).toEqual(['BA', 'AB', 'BA', 'AB']);
  });
});

describe('P2 output checksum', () => {
  it('changes for every required result field group', () => {
    const original = success();
    const baseline = checksum(original);
    const mutations: GeometrySuccessResult[] = [
      success({ requestId: 9 }),
      success({ sourceEpoch: 9 }),
      success({ sourceRevision: 9 }),
      success({ status: 'EMPTY' }),
      success({ bounds: { ...original.bounds, maxY: 10 } }),
      success({ verbs: new Uint8Array([0, 3]) }),
      success({ points: new Float64Array([1.25, -2.5, 3.75, 4.75]) }),
      success({ provenance: new Uint32Array([0, 1, 0, 1, 2, 2]) }),
    ];
    for (const mutation of mutations) expect(checksum(mutation)).not.toBe(baseline);
  });

  it('is independent of batch-call boundaries while retaining statuses and payload accounting', () => {
    const first = success();
    const second = success({ requestId: 2, sourceRevision: 4 });
    const oneBatch: GeometryBatchResult[] = [{ status: 'OK', results: [first, second] }];
    const perPath: GeometryBatchResult[] = [
      { status: 'OK', results: [first] },
      { status: 'OK', results: [second] },
    ];
    const batchSummary = checksumBatchResults(oneBatch);
    const perPathSummary = checksumBatchResults(perPath);
    expect(perPathSummary.checksum).toBe(batchSummary.checksum);
    expect(batchSummary).toMatchObject({
      resultCount: 2,
      copiedPayloadBytes: 2 * (2 + 4 * 8 + 6 * 4),
      peakRetainedPayloadBytes: 2 * (2 + 4 * 8 + 6 * 4),
      batchStatuses: ['OK'],
      pathStatuses: { OK: 2 },
    });
    expect(perPathSummary).toMatchObject({
      copiedPayloadBytes: batchSummary.copiedPayloadBytes,
      peakRetainedPayloadBytes: 2 + 4 * 8 + 6 * 4,
      batchStatuses: ['OK', 'OK'],
      pathStatuses: { OK: 2 },
    });
  });

  it('hashes structured path and batch failures', () => {
    const pathFailure: GeometryBatchResult = {
      status: 'OK',
      results: [
        {
          requestId: 1,
          sourceEpoch: 2,
          sourceRevision: 3,
          status: 'WORK_LIMIT',
          error: { code: 'WORK_LIMIT', message: 'bounded work exceeded' },
        },
      ],
    };
    const changedPathFailure: GeometryBatchResult = {
      status: 'OK',
      results: [
        {
          requestId: 1,
          sourceEpoch: 2,
          sourceRevision: 3,
          status: 'WORK_LIMIT',
          error: { code: 'WORK_LIMIT', message: 'different detail' },
        },
      ],
    };
    const batchFailure: GeometryBatchResult = {
      status: 'BATCH_ERROR',
      error: { code: 'RESOURCE_LIMIT', message: 'capacity' },
    };
    expect(checksumBatchResults([changedPathFailure]).checksum).not.toBe(
      checksumBatchResults([pathFailure]).checksum,
    );
    expect(checksumBatchResults([batchFailure]).checksum).not.toBe(
      checksumBatchResults([pathFailure]).checksum,
    );
  });
});
