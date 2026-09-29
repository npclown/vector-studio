import type { Rational } from './exact.js';

export type FillRule = 'nonzero' | 'evenodd';
export type ProfileName = 'I' | 'R16' | 'D32' | 'S192';
export type Expectation = 'OK' | 'TOPOLOGY_AMBIGUOUS';
export type Point = readonly [number, number];
export type ExactPoint = Readonly<{ x: Rational; y: Rational }>;

export type FixtureRow = Readonly<{
  id: string;
  rule: FillRule;
  tauBits: bigint;
  expectation: Expectation;
  profile: ProfileName;
  contours: readonly (readonly (readonly [bigint, bigint])[])[];
}>;

export type SourceRange = Readonly<{ start: number; count: number }>;
export type SourceEdge = Readonly<{ contour: number; start_vertex: number; end_vertex: number }>;
export type Column = Readonly<{ x: number; node_start: number; node_count: number }>;
export type Node = Readonly<{ point: Point; column: number; vertex: number | null }>;
export type Section = Readonly<{ column: number; node: number; edge: number; endpoint: number }>;
export type Cell = Readonly<{
  slab: number;
  nodes: readonly [number, number, number, number];
  lower_sources: SourceRange;
  upper_sources: SourceRange;
  lower_before: number;
  lower_after: number;
  upper_before: number;
  upper_after: number;
}>;
export type BoundaryKind = 'Lower' | 'Upper' | 'Vertical';
export type Boundary = Readonly<{
  from: number;
  to: number;
  kind: BoundaryKind;
  sources: SourceRange;
  before_winding: number;
  after_winding: number;
}>;
export type ColumnSpan = Readonly<{
  column: number;
  lower: number;
  upper: number;
  left_winding: number;
  right_winding: number;
  vertical_delta: number;
  vertical_sources: SourceRange;
}>;

export type ExpectedCarrier = Readonly<{
  vertices: readonly Point[];
  indices: readonly number[];
  bounds: readonly [number, number, number, number];
  source_edges: readonly SourceEdge[];
  columns: readonly Column[];
  nodes: readonly Node[];
  sections: readonly Section[];
  cells: readonly Cell[];
  boundaries: readonly Boundary[];
  spans: readonly ColumnSpan[];
  contributors: readonly number[];
  error_bound: number;
}>;

export type OracleSuccess = Readonly<{
  ok: true;
  carrier: ExpectedCarrier;
  exactArea: Rational;
  exactColumns: readonly Rational[];
  exactNodeY: readonly Rational[];
  rawEvents: number;
  properCrossings: number;
}>;
export type OracleAmbiguous = Readonly<{ ok: false; reason: string }>;
export type OracleResult = OracleSuccess | OracleAmbiguous;
