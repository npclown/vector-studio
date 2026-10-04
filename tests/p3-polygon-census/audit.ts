import { createHash } from 'node:crypto';

import { bitsOf, exactInteger } from '../geometry/rounded-fill/exact.js';
import {
  CONTACT_DOMAIN,
  MAX_EDGES,
  MAX_PAIRS,
  MAX_RAW_EMITTED,
  RELATIONS,
  contactTuple,
  type CarriedPath,
  type Classification,
  type Edge,
  type NormalizedPath,
  type Pair,
  type PairWitnesses,
  type Relation,
  type RelationCounts,
} from './types.js';

const MAX_SOURCES = 32;
const MAX_LINES_PER_SOURCE = 128;
const MAX_DEPTH = 7;

type ExactPoint = readonly [bigint, bigint];
type ExactEdge = Readonly<{ start: ExactPoint; end: ExactPoint }>;
type Bounds = Readonly<{
  index: number;
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}>;
type IntervalNode = Readonly<{
  record: Bounds;
  maxX: number;
  left: IntervalNode | null;
  right: IntervalNode | null;
}>;

function emptyCounts(): RelationCounts {
  return Object.fromEntries(RELATIONS.map((relation) => [relation, 0])) as RelationCounts;
}

function emptyWitnesses(): PairWitnesses {
  return Object.fromEntries(RELATIONS.map((relation) => [relation, null])) as PairWitnesses;
}

function checkedAdd(left: number, right: number, label: string): number {
  const result = left + right;
  if (!Number.isSafeInteger(result) || result < 0) throw new Error(`${label} exceeds safe count`);
  return result;
}

function checkedIncrement(counts: RelationCounts, relation: Relation): void {
  counts[relation] = checkedAdd(counts[relation], 1, relation);
}

function exactPoint(point: readonly [number, number]): ExactPoint {
  return [exactInteger(bitsOf(point[0])), exactInteger(bitsOf(point[1]))];
}

function exactEdge(edge: Edge): ExactEdge {
  return { start: exactPoint(edge.start), end: exactPoint(edge.end) };
}

function subtract(a: ExactPoint, b: ExactPoint): ExactPoint {
  return [a[0] - b[0], a[1] - b[1]];
}

function cross(a: ExactPoint, b: ExactPoint): bigint {
  return a[0] * b[1] - a[1] * b[0];
}

function sameExactPoint(a: ExactPoint, b: ExactPoint): boolean {
  return a[0] === b[0] && a[1] === b[1];
}

function betweenInclusive(numerator: bigint, denominator: bigint): boolean {
  return numerator >= 0n && numerator <= denominator;
}

function atParameterEndpoint(numerator: bigint, denominator: bigint): boolean {
  return numerator === 0n || numerator === denominator;
}

function collinearRelation(a: ExactEdge, b: ExactEdge): Relation {
  if (sameExactPoint(a.start, b.start) && sameExactPoint(a.end, b.end)) {
    return 'COINCIDENT_SAME';
  }
  if (sameExactPoint(a.start, b.end) && sameExactPoint(a.end, b.start)) {
    return 'COINCIDENT_REVERSED';
  }

  const useX = a.start[0] !== a.end[0];
  const a0 = useX ? a.start[0] : a.start[1];
  const a1 = useX ? a.end[0] : a.end[1];
  const b0 = useX ? b.start[0] : b.start[1];
  const b1 = useX ? b.end[0] : b.end[1];
  const lower = (left: bigint, right: bigint): bigint => (left < right ? left : right);
  const upper = (left: bigint, right: bigint): bigint => (left > right ? left : right);
  const overlapStart = upper(lower(a0, a1), lower(b0, b1));
  const overlapEnd = lower(upper(a0, a1), upper(b0, b1));
  if (overlapStart > overlapEnd) return 'DISJOINT';
  if (overlapStart === overlapEnd) return 'COLLINEAR_POINT';
  return 'COLLINEAR_OVERLAP';
}

function relationOfExact(a: ExactEdge, b: ExactEdge): Relation {
  const r = subtract(a.end, a.start);
  const s = subtract(b.end, b.start);
  const offset = subtract(b.start, a.start);
  let denominator = cross(r, s);
  let firstNumerator = cross(offset, s);
  let secondNumerator = cross(offset, r);

  if (denominator === 0n) {
    return cross(offset, r) === 0n ? collinearRelation(a, b) : 'DISJOINT';
  }
  if (denominator < 0n) {
    denominator = -denominator;
    firstNumerator = -firstNumerator;
    secondNumerator = -secondNumerator;
  }
  if (
    !betweenInclusive(firstNumerator, denominator) ||
    !betweenInclusive(secondNumerator, denominator)
  ) {
    return 'DISJOINT';
  }

  const firstEndpoint = atParameterEndpoint(firstNumerator, denominator);
  const secondEndpoint = atParameterEndpoint(secondNumerator, denominator);
  if (!firstEndpoint && !secondEndpoint) return 'PROPER_CROSSING';
  return firstEndpoint && secondEndpoint ? 'ENDPOINT_TOUCH' : 'T_JUNCTION';
}

function assertPoint(value: unknown, label: string): asserts value is readonly [number, number] {
  if (!Array.isArray(value) || value.length !== 2) throw new Error(`${label} must be a point`);
  if (!Number.isFinite(value[0]) || !Number.isFinite(value[1])) {
    throw new Error(`${label} coordinates must be finite`);
  }
}

function assertEdge(value: unknown, label: string): asserts value is Edge {
  if (typeof value !== 'object' || value === null) throw new Error(`${label} must be an edge`);
  const candidate = value as Partial<Edge>;
  if (
    !Number.isSafeInteger(candidate.rawIndex) ||
    candidate.rawIndex === undefined ||
    candidate.rawIndex < 0 ||
    candidate.rawIndex > MAX_RAW_EMITTED
  ) {
    throw new Error(`${label}.rawIndex is outside the fixed cap`);
  }
  if (candidate.kind !== 'emitted' && candidate.kind !== 'closure') {
    throw new Error(`${label}.kind is invalid`);
  }
  assertPoint(candidate.start, `${label}.start`);
  assertPoint(candidate.end, `${label}.end`);
  if (candidate.start[0] === candidate.end[0] && candidate.start[1] === candidate.end[1]) {
    throw new Error(`${label} is a mathematical zero edge`);
  }
  if (candidate.kind === 'closure') {
    if (
      candidate.sourceVerbOrdinal !== null ||
      candidate.endNumerator !== null ||
      candidate.depth !== null
    ) {
      throw new Error(`${label} closure provenance must be null`);
    }
  } else {
    const source = candidate.sourceVerbOrdinal;
    const numerator = candidate.endNumerator;
    const depth = candidate.depth;
    if (
      typeof source !== 'number' ||
      !Number.isSafeInteger(source) ||
      source < 1 ||
      source > MAX_SOURCES ||
      typeof numerator !== 'number' ||
      !Number.isSafeInteger(numerator) ||
      numerator < 1 ||
      typeof depth !== 'number' ||
      !Number.isSafeInteger(depth) ||
      depth < 0 ||
      depth > MAX_DEPTH ||
      numerator > 2 ** depth
    ) {
      throw new Error(`${label} emitted provenance is invalid`);
    }
  }
}

function validateStandaloneEdge(edge: Edge, label: string): ExactEdge {
  assertEdge(edge, label);
  return exactEdge(edge);
}

export function auditPair(a: Edge, b: Edge): Relation {
  return relationOfExact(
    validateStandaloneEdge(a, 'first edge'),
    validateStandaloneEdge(b, 'second edge'),
  );
}

function boundsOf(edge: Edge, index: number): Bounds {
  return {
    index,
    minX: Math.min(edge.start[0], edge.end[0]),
    maxX: Math.max(edge.start[0], edge.end[0]),
    minY: Math.min(edge.start[1], edge.end[1]),
    maxY: Math.max(edge.start[1], edge.end[1]),
  };
}

function boxesOverlap(a: Bounds, b: Bounds): boolean {
  return !(a.maxX < b.minX || b.maxX < a.minX || a.maxY < b.minY || b.maxY < a.minY);
}

function buildIntervalIndex(
  records: readonly Bounds[],
  start = 0,
  end = records.length,
): IntervalNode | null {
  if (start >= end) return null;
  const middle = start + Math.floor((end - start) / 2);
  const record = records[middle];
  if (record === undefined) throw new Error('x-interval index record is absent');
  const left = buildIntervalIndex(records, start, middle);
  const right = buildIntervalIndex(records, middle + 1, end);
  return {
    record,
    maxX: Math.max(record.maxX, left?.maxX ?? -Infinity, right?.maxX ?? -Infinity),
    left,
    right,
  };
}

function collectCandidates(
  node: IntervalNode | null,
  query: Bounds,
  firstIndex: number,
  output: number[],
): void {
  if (node === null || node.maxX < query.minX) return;
  if (node.left !== null) collectCandidates(node.left, query, firstIndex, output);
  const candidate = node.record;
  if (
    candidate.minX <= query.maxX &&
    candidate.maxX >= query.minX &&
    candidate.index > firstIndex &&
    candidate.maxY >= query.minY &&
    query.maxY >= candidate.minY
  ) {
    output.push(candidate.index);
  }
  if (candidate.minX <= query.maxX && node.right !== null) {
    collectCandidates(node.right, query, firstIndex, output);
  }
}

function adjacentPair(i: number, j: number, edgeCount: number): boolean {
  return edgeCount >= 2 && (j === i + 1 || (i === 0 && j === edgeCount - 1));
}

function lexicographicallyEarlier(left: Pair | null, right: Pair | null): Pair | null {
  if (left === null) return right;
  if (right === null) return left;
  return right[0] < left[0] || (right[0] === left[0] && right[1] < left[1]) ? right : left;
}

function firstRejectedPair(bounds: readonly Bounds[]): Pair | null {
  for (let i = 0; i < bounds.length; i += 1) {
    const first = bounds[i];
    if (first === undefined) throw new Error('edge bounds are absent');
    for (let j = i + 1; j < bounds.length; j += 1) {
      const second = bounds[j];
      if (second === undefined) throw new Error('edge bounds are absent');
      if (!boxesOverlap(first, second)) return [i, j];
    }
  }
  return null;
}

function validateEdgeArray(edges: readonly Edge[]): readonly ExactEdge[] {
  const candidateEdges: unknown = edges;
  if (!Array.isArray(candidateEdges)) throw new Error('edges must be an array');
  if (edges.length > MAX_EDGES) throw new Error('edge count exceeds the fixed cap');
  const exact: ExactEdge[] = [];
  let previousRawIndex = -1;
  let closureSeen = false;
  for (let index = 0; index < edges.length; index += 1) {
    if (!Object.hasOwn(edges, index)) throw new Error(`edge ${index} is absent`);
    const edge: unknown = edges[index];
    assertEdge(edge, `edge ${index}`);
    if (edge.rawIndex <= previousRawIndex) throw new Error('edge raw indices are not increasing');
    if (closureSeen) throw new Error('closure must be the final edge');
    if (edge.kind === 'closure') closureSeen = true;
    previousRawIndex = edge.rawIndex;
    exact.push(exactEdge(edge));
  }
  return exact;
}

export function auditEdges(edges: readonly Edge[]): Classification {
  const exact = validateEdgeArray(edges);
  const edgeCount = edges.length;
  const pairs = edgeCount < 2 ? 0 : (edgeCount * (edgeCount - 1)) / 2;
  if (!Number.isSafeInteger(pairs) || pairs < 0 || pairs > MAX_PAIRS) {
    throw new Error('pair count exceeds the fixed cap');
  }

  const bounds = edges.map(boundsOf);
  const sorted = [...bounds].sort(
    (left, right) => left.minX - right.minX || left.index - right.index,
  );
  const intervalIndex = buildIntervalIndex(sorted);
  const counts = emptyCounts();
  const adjacent = emptyCounts();
  const nonadjacent = emptyCounts();
  const first = emptyWitnesses();
  const hash = createHash('sha256').update(CONTACT_DOMAIN, 'utf8');
  let exactTested = 0;
  let exactDisjointFirst: Pair | null = null;
  let peakCandidateRecords = 0;

  for (let i = 0; i < edgeCount; i += 1) {
    const query = bounds[i];
    if (query === undefined) throw new Error('edge bounds are absent');
    const candidates: number[] = [];
    collectCandidates(intervalIndex, query, i, candidates);
    candidates.sort((left, right) => left - right);
    peakCandidateRecords = Math.max(peakCandidateRecords, candidates.length);
    for (const j of candidates) {
      const second = exact[j];
      const firstExact = exact[i];
      const firstEdge = edges[i];
      const secondEdge = edges[j];
      if (
        firstExact === undefined ||
        second === undefined ||
        firstEdge === undefined ||
        secondEdge === undefined
      ) {
        throw new Error('candidate edge is absent');
      }
      exactTested = checkedAdd(exactTested, 1, 'exact-tested pairs');
      const relation = relationOfExact(firstExact, second);
      const pair: Pair = [i, j];
      const isAdjacent = adjacentPair(i, j, edgeCount);
      checkedIncrement(counts, relation);
      checkedIncrement(isAdjacent ? adjacent : nonadjacent, relation);
      if (first[relation] === null) first[relation] = pair;
      if (relation === 'DISJOINT') {
        exactDisjointFirst ??= pair;
      } else {
        hash.update(
          contactTuple(i, j, firstEdge.rawIndex, secondEdge.rawIndex, relation, isAdjacent),
        );
      }
    }
  }

  const aabbRejected = pairs - exactTested;
  if (!Number.isSafeInteger(aabbRejected) || aabbRejected < 0) {
    throw new Error('AABB rejection count is inconsistent');
  }
  counts.DISJOINT = checkedAdd(counts.DISJOINT, aabbRejected, 'DISJOINT');
  let rejectedAdjacent = 0;
  if (edgeCount >= 2) {
    for (let i = 0; i < edgeCount - 1; i += 1) {
      const firstBounds = bounds[i];
      const secondBounds = bounds[i + 1];
      if (firstBounds === undefined || secondBounds === undefined)
        throw new Error('edge bounds are absent');
      if (!boxesOverlap(firstBounds, secondBounds)) rejectedAdjacent += 1;
    }
    const firstBounds = bounds[0];
    const lastBounds = bounds[edgeCount - 1];
    if (firstBounds === undefined || lastBounds === undefined)
      throw new Error('edge bounds are absent');
    if (edgeCount > 2 && !boxesOverlap(firstBounds, lastBounds)) rejectedAdjacent += 1;
  }
  adjacent.DISJOINT = checkedAdd(adjacent.DISJOINT, rejectedAdjacent, 'adjacent DISJOINT');
  if (rejectedAdjacent > aabbRejected) {
    throw new Error('rejected adjacency count exceeds AABB rejections');
  }
  nonadjacent.DISJOINT = checkedAdd(
    nonadjacent.DISJOINT,
    aabbRejected - rejectedAdjacent,
    'nonadjacent DISJOINT',
  );
  first.DISJOINT = lexicographicallyEarlier(firstRejectedPair(bounds), exactDisjointFirst);

  for (const relation of RELATIONS) {
    if (adjacent[relation] + nonadjacent[relation] !== counts[relation]) {
      throw new Error(`${relation} adjacency accounting is inconsistent`);
    }
    if ((first[relation] === null) !== (counts[relation] === 0)) {
      throw new Error(`${relation} witness accounting is inconsistent`);
    }
  }
  if (exactTested + aabbRejected !== pairs) throw new Error('pair accounting is inconsistent');
  if (peakCandidateRecords > edgeCount) throw new Error('candidate storage exceeds the edge cap');

  return {
    edges: edgeCount,
    pairs,
    aabbRejected,
    exactTested,
    counts,
    adjacent,
    nonadjacent,
    first,
    contactSha256: hash.digest('hex'),
    peakCandidateRecords,
  };
}

function assertCarriedShape(path: CarriedPath): void {
  if (typeof path !== 'object' || path === null) throw new Error('carried path must be an object');
  if (!(path.verbs instanceof Uint8Array)) throw new Error('verbs must be Uint8Array');
  if (!(path.points instanceof Float64Array)) throw new Error('points must be Float64Array');
  if (!(path.provenance instanceof Uint32Array)) throw new Error('provenance must be Uint32Array');
  if (path.verbs.length === 0) throw new Error('carried path must start with MOVE');
  if (path.verbs.length - 1 > MAX_RAW_EMITTED) {
    throw new Error('raw emitted count exceeds the fixed cap');
  }
  if (path.points.length > 2 * (MAX_RAW_EMITTED + 1)) {
    throw new Error('point scalar count exceeds the fixed cap');
  }
  if (path.provenance.length > 3 * (MAX_RAW_EMITTED + 1)) {
    throw new Error('provenance scalar count exceeds the fixed cap');
  }
  if (path.points.length !== path.verbs.length * 2) {
    throw new Error('verb/point cardinality is inconsistent');
  }
  if (path.provenance.length !== path.verbs.length * 3) {
    throw new Error('verb/provenance cardinality is inconsistent');
  }
}

function assertProvenance(path: CarriedPath): void {
  if (path.verbs[0] !== 0) throw new Error('first carried command must be MOVE');
  if (path.provenance[0] !== 0 || path.provenance[1] !== 1 || path.provenance[2] !== 0) {
    throw new Error('MOVE provenance is invalid');
  }

  let activeSource = 0;
  let sourceLines = 0;
  let previousNumerator = 0;
  let previousDenominator = 1;
  for (let command = 1; command < path.verbs.length; command += 1) {
    if (path.verbs[command] !== 1) throw new Error(`carried command ${command} must be LINE`);
    const offset = command * 3;
    const source = path.provenance[offset];
    const numerator = path.provenance[offset + 1];
    const depth = path.provenance[offset + 2];
    if (source === undefined || numerator === undefined || depth === undefined) {
      throw new Error(`LINE ${command - 1} provenance is absent`);
    }
    if (source < 1 || source > MAX_SOURCES) {
      throw new Error(`LINE ${command - 1} source ordinal is invalid`);
    }
    if (source !== activeSource) {
      if (activeSource !== 0 && previousNumerator !== previousDenominator) {
        throw new Error(`source ${activeSource} provenance does not cover [0,1]`);
      }
      if (source !== activeSource + 1) throw new Error('source ordinals are not contiguous');
      activeSource = source;
      sourceLines = 0;
      previousNumerator = 0;
      previousDenominator = 1;
    }
    if (depth > MAX_DEPTH) throw new Error(`LINE ${command - 1} depth exceeds the fixed cap`);
    const denominator = 2 ** depth;
    if (numerator < 1 || numerator > denominator) {
      throw new Error(`LINE ${command - 1} numerator is invalid`);
    }
    if (previousNumerator * denominator !== (numerator - 1) * previousDenominator) {
      throw new Error(`source ${source} provenance intervals are not contiguous`);
    }
    sourceLines += 1;
    if (sourceLines > MAX_LINES_PER_SOURCE) {
      throw new Error(`source ${source} emitted-line count exceeds the fixed cap`);
    }
    previousNumerator = numerator;
    previousDenominator = denominator;
  }
  if (activeSource !== 0 && previousNumerator !== previousDenominator) {
    throw new Error(`source ${activeSource} provenance does not cover [0,1]`);
  }
}

export function auditExtractEdges(path: CarriedPath): NormalizedPath {
  assertCarriedShape(path);
  assertProvenance(path);
  for (let index = 0; index < path.points.length; index += 1) {
    if (!Number.isFinite(path.points[index]))
      throw new Error(`point scalar ${index} must be finite`);
  }

  const move: readonly [number, number] = [path.points[0]!, path.points[1]!];
  let current = move;
  let omittedZero = 0;
  const edges: Edge[] = [];
  const rawEmitted = path.verbs.length - 1;
  for (let command = 1; command < path.verbs.length; command += 1) {
    const pointOffset = command * 2;
    const provenanceOffset = command * 3;
    const end: readonly [number, number] = [
      path.points[pointOffset]!,
      path.points[pointOffset + 1]!,
    ];
    if (current[0] === end[0] && current[1] === end[1]) {
      omittedZero += 1;
    } else {
      edges.push({
        rawIndex: command - 1,
        kind: 'emitted',
        sourceVerbOrdinal: path.provenance[provenanceOffset]!,
        endNumerator: path.provenance[provenanceOffset + 1]!,
        depth: path.provenance[provenanceOffset + 2]!,
        start: current,
        end,
      });
    }
    current = end;
  }

  const retainedEmitted = edges.length;
  let closure: 0 | 1 = 0;
  if (current[0] !== move[0] || current[1] !== move[1]) {
    edges.push({
      rawIndex: rawEmitted,
      kind: 'closure',
      sourceVerbOrdinal: null,
      endNumerator: null,
      depth: null,
      start: current,
      end: move,
    });
    closure = 1;
  }
  if (edges.length > MAX_EDGES) throw new Error('normalized edge count exceeds the fixed cap');

  return {
    edges,
    rawEmitted,
    omittedZero,
    retainedEmitted,
    closure,
    normalizedEdges: edges.length,
  };
}
