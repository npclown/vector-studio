export type Point = readonly [x: number, y: number];

export type Cubic = readonly [p0: Point, p1: Point, p2: Point, p3: Point];

export type Bounds = Readonly<{
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}>;

/** Row-major linear matrix: x'=m00*x+m01*y, y'=m10*x+m11*y. */
export type Matrix2 = readonly [m00: number, m01: number, m10: number, m11: number];

export const REFERENCE_VERB = Object.freeze({
  MOVE: 0,
  LINE: 1,
  CUBIC: 2,
  CLOSE: 3,
} as const);

export type ReferenceVerb = (typeof REFERENCE_VERB)[keyof typeof REFERENCE_VERB];

export const REFERENCE_PATH_STATUS = Object.freeze({
  OK: 0,
  EMPTY: 1,
  INVALID_PATH: 2,
  INVALID_TOLERANCE: 3,
  NUMERIC_RANGE: 4,
  WORK_LIMIT: 5,
} as const);

export type ReferencePathStatus =
  (typeof REFERENCE_PATH_STATUS)[keyof typeof REFERENCE_PATH_STATUS];

export type ReferenceRequest = Readonly<{
  requestId: number;
  sourceEpoch: number;
  sourceRevision: number;
  bucketTolerance: number;
}>;

export type CanonicalPackedInput = Readonly<{
  requests: readonly ReferenceRequest[];
  pathOffsets: ArrayLike<number>;
  pointOffsets: ArrayLike<number>;
  verbs: ArrayLike<number>;
  points: ArrayLike<number>;
}>;

export type ReferencePathBoundsResult = Readonly<{
  requestId: number;
  sourceEpoch: number;
  sourceRevision: number;
  status: ReferencePathStatus;
  bounds: Bounds;
  findings: readonly string[];
}>;

export type CanonicalValidationResult =
  | Readonly<{ ok: false; findings: readonly string[] }>
  | Readonly<{ ok: true; paths: readonly ReferencePathBoundsResult[] }>;

export type ReferenceProvenance = Readonly<{
  sourceVerbOrdinal: number;
  endNumerator: number;
  depth: number;
}>;

export type ReferenceFlattenedLine = Readonly<{
  end: Point;
  provenance: ReferenceProvenance;
}>;

export type ContinuousErrorResult = Readonly<{
  ok: boolean;
  findings: readonly string[];
  cells: number;
  maxEvaluatedError: number;
  maxCertifiedUpperBound: number;
}>;

export type BoundsValidationResult = Readonly<{
  ok: boolean;
  findings: readonly string[];
  expected: Bounds | null;
  tolerance: number | null;
}>;

export type ScreenToleranceResult =
  | Readonly<{
      ok: true;
      screen: Matrix2;
      sigmaMax: number;
      bucketTolerance: number;
    }>
  | Readonly<{
      ok: false;
      status: 'INVALID_TOLERANCE' | 'NUMERIC_RANGE';
      finding: string;
    }>;

export type GeometryCorpusCase = Readonly<{
  version: 'p2-geometry/v1';
  index: number;
  seed: number;
  seedIndex: number;
  cubic: Cubic;
  localTransform: string;
  world: Matrix2;
  zoom: number;
  dpr: number;
  bucketTolerance: number;
}>;

export type NamedCubicFixture = Readonly<{
  name: string;
  cubic: Cubic;
  expectation: 'success' | 'numeric-range';
}>;

export type NamedPackedFixture = Readonly<{
  name: string;
  input: CanonicalPackedInput;
  envelopeValid: boolean;
  statuses?: readonly ReferencePathStatus[];
}>;

export type MetamorphicCubicFixture = Readonly<{
  name: string;
  source: Cubic;
  transformed: Cubic;
  transform: 'reverse' | 'translate' | 'uniform-scale';
}>;

export type SubdivisionMetamorphicFixture = Readonly<{
  name: string;
  source: Cubic;
  halves: readonly [left: Cubic, right: Cubic];
}>;

export type ContinuousPositiveControl = Readonly<{
  name: string;
  cubic: Cubic;
  lines: readonly ReferenceFlattenedLine[];
  expectedFinding: string;
}>;
