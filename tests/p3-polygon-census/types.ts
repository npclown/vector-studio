import { createHash } from 'node:crypto';

export const RELATIONS = [
  'DISJOINT',
  'PROPER_CROSSING',
  'ENDPOINT_TOUCH',
  'T_JUNCTION',
  'COLLINEAR_POINT',
  'COINCIDENT_SAME',
  'COINCIDENT_REVERSED',
  'COLLINEAR_OVERLAP',
] as const;
export const MAX_EDGES = 4097;
export const MAX_RAW_EMITTED = 4096;
export const MAX_PAIRS = 8_390_656;
export const CONTACT_DOMAIN = 'p3-polygon-contacts/v1\n';

export type Point = readonly [number, number];
export type Relation = (typeof RELATIONS)[number];
export type Pair = readonly [number, number];
export type RelationCounts = Record<Relation, number>;
export type PairWitnesses = Record<Relation, Pair | null>;
export type Edge = Readonly<{
  rawIndex: number;
  kind: 'emitted' | 'closure';
  sourceVerbOrdinal: number | null;
  endNumerator: number | null;
  depth: number | null;
  start: Point;
  end: Point;
}>;
export type CarriedPath = Readonly<{
  verbs: Uint8Array;
  points: Float64Array;
  provenance: Uint32Array;
}>;
export type NormalizedPath = Readonly<{
  edges: readonly Edge[];
  rawEmitted: number;
  omittedZero: number;
  retainedEmitted: number;
  closure: 0 | 1;
  normalizedEdges: number;
}>;
export type Classification = Readonly<{
  edges: number;
  pairs: number;
  aabbRejected: number;
  exactTested: number;
  counts: RelationCounts;
  adjacent: RelationCounts;
  nonadjacent: RelationCounts;
  first: PairWitnesses;
  contactSha256: string;
  peakCandidateRecords: number;
}>;
export type CanonicalEdge = Readonly<{
  rawIndex: number;
  kind: Edge['kind'];
  sourceVerbOrdinal: number | null;
  endNumerator: number | null;
  depth: number | null;
  startBits: readonly [string, string];
  endBits: readonly [string, string];
}>;

function pointBits(point: Point): readonly [string, string] {
  const bytes = Buffer.alloc(16);
  bytes.writeDoubleBE(point[0], 0);
  bytes.writeDoubleBE(point[1], 8);
  return [bytes.subarray(0, 8).toString('hex'), bytes.subarray(8).toString('hex')];
}

export function canonicalEdge(edge: Edge): CanonicalEdge {
  return {
    rawIndex: edge.rawIndex,
    kind: edge.kind,
    sourceVerbOrdinal: edge.sourceVerbOrdinal,
    endNumerator: edge.endNumerator,
    depth: edge.depth,
    startBits: pointBits(edge.start),
    endBits: pointBits(edge.end),
  };
}

export function normalizedEdgeSha256(edges: readonly Edge[]): string {
  return createHash('sha256')
    .update('p3-polygon-edges/v1\n', 'utf8')
    .update(JSON.stringify(edges.map(canonicalEdge)), 'utf8')
    .digest('hex');
}

export function contactTuple(
  i: number,
  j: number,
  firstRawIndex: number,
  secondRawIndex: number,
  relation: Relation,
  adjacent: boolean,
): Buffer {
  const bytes = Buffer.alloc(18);
  bytes.writeUInt32LE(i, 0);
  bytes.writeUInt32LE(j, 4);
  bytes.writeUInt32LE(firstRawIndex, 8);
  bytes.writeUInt32LE(secondRawIndex, 12);
  bytes[16] = RELATIONS.indexOf(relation);
  bytes[17] = adjacent ? 1 : 0;
  return bytes;
}
