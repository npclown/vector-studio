// Fill-mesh port of the P3 V1 path scene proposal (docs/plans/p3-v1-path-scene-port-proposal.md,
// section b) and ADR 0002. Plain data only: requests and results carry typed numeric buffers
// and plain values, never runtime handles of an implementation.

/** Equal to the P2 v1 verb bytes. */
export const PATH_VERB_CODES = Object.freeze({ move: 0, line: 1, cubic: 2, close: 3 } as const);

export interface FillMeshRequest {
  /** u32, unique within one batch; echoed in the result. */
  readonly requestId: number;
  readonly verbs: Uint8Array;
  /** Interleaved node-local x, y. */
  readonly points: Float64Array;
  readonly fillRule: 'nonzero' | 'evenodd';
  /** Integer e; the local flattening tolerance is exactly 2^e local units. */
  readonly toleranceExponent: number;
}

export interface FillMesh {
  /** Node-local x, y per vertex, Float64. */
  readonly positions: Float64Array;
  /** Three vertex indices per triangle. */
  readonly indices: Uint32Array;
  /** Vertex-index pairs (a, b), one per boundary mesh edge; see rule 5 for the orientation. */
  readonly boundaryEdges: Uint32Array;
  readonly bounds: Readonly<{ minX: number; minY: number; maxX: number; maxY: number }>;
}

export type FillMeshFailureCode =
  'invalid-path' | 'invalid-tolerance' | 'numeric-range' | 'work-limit' | 'unsupported-geometry';

type FillMeshEcho = Readonly<{ requestId: number; toleranceExponent: number }>;

export type FillMeshResult =
  | (FillMeshEcho & Readonly<{ status: 'ok'; mesh: FillMesh }>)
  | (FillMeshEcho & Readonly<{ status: 'empty' }>)
  | (FillMeshEcho & Readonly<{ status: 'failed'; code: FillMeshFailureCode }>);

export type FillMeshBatchResult =
  | Readonly<{ status: 'ok'; results: readonly FillMeshResult[] }>
  | Readonly<{
      status: 'batch-failed';
      code: 'invalid-request' | 'disposed' | 'resource-limit' | 'internal-error';
    }>;

export interface FillMeshPort {
  readonly portVersion: 0;
  /** Names the implementation's operation and error budget, for example 'geometry-wasm/fill-v0'. */
  readonly operationId: string;
  buildFillMeshes(requests: readonly FillMeshRequest[]): FillMeshBatchResult;
}

// Stroke-mesh port of the B2 stroke contract (docs/plans/p3-b2-stroke-contract.md, section 6).
// Plain data only, as for the fill-mesh port. V1 rules 1-8 apply unchanged, with rule 5's
// region being the stroke region of contract section 2.2.

export interface StrokeMeshRequest {
  /** u32, unique within one batch; echoed. */
  readonly requestId: number;
  readonly verbs: Uint8Array;
  /** Interleaved node-local x, y. */
  readonly points: Float64Array;
  readonly width: number;
  readonly cap: 'butt' | 'round' | 'square';
  readonly join: 'miter' | 'round' | 'bevel';
  readonly miterLimit: number;
  /** Integer e; the curve share is 2^e local units (stroke contract section 3). */
  readonly toleranceExponent: number;
}

/** Same shape and meaning as FillMesh (V1 rule 5), for the stroke region. */
export type StrokeMesh = FillMesh;

export type StrokeMeshFailureCode = FillMeshFailureCode | 'invalid-stroke';

type StrokeMeshEcho = Readonly<{ requestId: number; toleranceExponent: number }>;

export type StrokeMeshResult =
  | (StrokeMeshEcho & Readonly<{ status: 'ok'; mesh: StrokeMesh }>)
  | (StrokeMeshEcho & Readonly<{ status: 'empty' }>)
  | (StrokeMeshEcho & Readonly<{ status: 'failed'; code: StrokeMeshFailureCode }>);

export type StrokeMeshBatchResult =
  | Readonly<{ status: 'ok'; results: readonly StrokeMeshResult[] }>
  | Readonly<{
      status: 'batch-failed';
      code: 'invalid-request' | 'disposed' | 'resource-limit' | 'internal-error';
    }>;

export interface StrokeMeshPort {
  readonly portVersion: 0;
  /** Names the operation and its error budget, for example 'geometry-wasm/stroke-v0'. */
  readonly operationId: string;
  buildStrokeMeshes(requests: readonly StrokeMeshRequest[]): StrokeMeshBatchResult;
}
