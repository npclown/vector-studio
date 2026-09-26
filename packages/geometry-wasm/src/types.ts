export const GEOMETRY_VERB = {
  MOVE: 0,
  LINE: 1,
  CUBIC: 2,
  CLOSE: 3,
} as const;

export type GeometryFillRule = 'nonzero' | 'evenodd';
export type GeometryMatrix2 = readonly [number, number, number, number];

export interface GeometryRequest {
  readonly domainId: string;
  readonly nodeId: string;
  readonly requestId: number;
  readonly sourceEpoch: number;
  readonly sourceRevision: number;
  readonly verbs: Uint8Array;
  readonly points: Float64Array;
  readonly strokeStyleHash: string;
  readonly fillRule: GeometryFillRule;
  /** Row-major [[a, b], [c, d]]. */
  readonly world: GeometryMatrix2;
  readonly zoom: number;
  readonly devicePixelRatio: number;
}

export interface GeometryBounds {
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
}

interface GeometrySourceEcho {
  readonly requestId: number;
  readonly sourceEpoch: number;
  readonly sourceRevision: number;
}

export interface GeometrySuccessResult extends GeometrySourceEcho {
  readonly status: 'OK' | 'EMPTY';
  readonly bounds: GeometryBounds;
  readonly verbs: Uint8Array;
  readonly points: Float64Array;
  /** Triplets of source verb ordinal, dyadic end numerator and depth. */
  readonly provenance: Uint32Array;
}

export type GeometryPathErrorCode =
  | 'INVALID_PATH'
  | 'INVALID_TOLERANCE'
  | 'NUMERIC_RANGE'
  | 'WORK_LIMIT'
  | 'STALE_SOURCE'
  | 'REVISION_CONFLICT';

export interface GeometryPathErrorResult extends GeometrySourceEcho {
  readonly status: GeometryPathErrorCode;
  readonly error: {
    readonly code: GeometryPathErrorCode;
    readonly message: string;
  };
}

export type GeometryResult = GeometrySuccessResult | GeometryPathErrorResult;

export type GeometryBatchErrorCode =
  | 'INVALID_REQUEST'
  | 'INVALID_BATCH'
  | 'ALLOCATION_FAILED'
  | 'DISPOSED'
  | 'RESOURCE_LIMIT'
  | 'INTERNAL_ERROR'
  | 'ABI_CONTRACT'
  | 'WASM_TRAP';

export type GeometryBatchResult =
  | {
      readonly status: 'OK';
      readonly results: readonly GeometryResult[];
    }
  | {
      readonly status: 'BATCH_ERROR';
      readonly error: {
        readonly code: GeometryBatchErrorCode;
        readonly message: string;
      };
    };

export interface GeometryKernelWork {
  readonly logicalCubics: bigint;
  readonly sizingVisits: bigint;
  readonly emissionVisits: bigint;
  readonly emittedCubicLines: bigint;
  readonly attemptedPaths: bigint;
  readonly failedPaths: bigint;
}

export interface GeometrySessionStatistics {
  readonly hits: number;
  readonly misses: number;
  readonly kernelPathBuilds: number;
  readonly evictions: number;
  readonly retainedPayloadBytes: number;
  readonly liveLinearMemoryBytes: number;
  readonly residentNodes: number;
  readonly variantEntries: number;
  readonly kernelWork: GeometryKernelWork;
}

export interface GeometryCacheOptions {
  readonly maxVariants?: number;
  readonly maxNodes?: number;
  readonly maxPayloadBytes?: number;
}

export interface GeometrySessionOptions {
  readonly cache?: GeometryCacheOptions;
}

export interface GeometryKernelExports {
  readonly memory: WebAssembly.Memory;
  readonly abi_version: () => number;
  readonly reserve: (inputBytes: number, outputBytes: number) => number;
  readonly input_ptr: () => number;
  readonly input_capacity: () => number;
  readonly output_ptr: () => number;
  readonly output_capacity: () => number;
  readonly memory_epoch: () => number;
  readonly process: (inputLength: number) => number;
  readonly result_len: () => number;
  readonly required_output_bytes: () => number;
  readonly statistics_ptr: () => number;
  readonly dispose: () => number;
}
