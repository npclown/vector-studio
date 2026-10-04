import { createHash } from 'node:crypto';
import { bitsOf, exactInteger } from '../geometry/rounded-fill/exact.js';
import {
  CONTACT_DOMAIN,
  MAX_EDGES,
  MAX_PAIRS,
  RELATIONS,
  contactTuple,
  type Classification,
  type Edge,
  type PairWitnesses,
  type Point,
  type Relation,
  type RelationCounts,
} from './types.js';

type ExactPoint = readonly [bigint, bigint];
type ExactEdge = Readonly<{
  start: ExactPoint;
  end: ExactPoint;
}>;
type CachedEdge = Readonly<{
  edge: Edge;
  exact: ExactEdge;
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}>;

const UINT32_MAX = 0xffff_ffff;

function emptyCounts(): RelationCounts {
  return {
    DISJOINT: 0,
    PROPER_CROSSING: 0,
    ENDPOINT_TOUCH: 0,
    T_JUNCTION: 0,
    COLLINEAR_POINT: 0,
    COINCIDENT_SAME: 0,
    COINCIDENT_REVERSED: 0,
    COLLINEAR_OVERLAP: 0,
  };
}

function emptyWitnesses(): PairWitnesses {
  return {
    DISJOINT: null,
    PROPER_CROSSING: null,
    ENDPOINT_TOUCH: null,
    T_JUNCTION: null,
    COLLINEAR_POINT: null,
    COINCIDENT_SAME: null,
    COINCIDENT_REVERSED: null,
    COLLINEAR_OVERLAP: null,
  };
}

function validatePoint(point: Point, label: string): void {
  if (!Number.isFinite(point[0]) || !Number.isFinite(point[1])) {
    throw new Error(`${label} must contain finite coordinates`);
  }
}

function validateEdge(edge: Edge, label: string): void {
  validatePoint(edge.start, `${label}.start`);
  validatePoint(edge.end, `${label}.end`);
  if (edge.start[0] === edge.end[0] && edge.start[1] === edge.end[1]) {
    throw new Error(`${label} must be nonzero`);
  }
  if (!Number.isInteger(edge.rawIndex) || edge.rawIndex < 0 || edge.rawIndex > UINT32_MAX) {
    throw new Error(`${label}.rawIndex must be a uint32`);
  }
}

function exactPoint(point: Point): ExactPoint {
  return [exactInteger(bitsOf(point[0])), exactInteger(bitsOf(point[1]))];
}

function cacheEdge(edge: Edge): CachedEdge {
  return {
    edge,
    exact: { start: exactPoint(edge.start), end: exactPoint(edge.end) },
    minX: Math.min(edge.start[0], edge.end[0]),
    maxX: Math.max(edge.start[0], edge.end[0]),
    minY: Math.min(edge.start[1], edge.end[1]),
    maxY: Math.max(edge.start[1], edge.end[1]),
  };
}

function boxesAreDisjoint(a: CachedEdge, b: CachedEdge): boolean {
  return a.maxX < b.minX || b.maxX < a.minX || a.maxY < b.minY || b.maxY < a.minY;
}

function orientation(a: ExactPoint, b: ExactPoint, point: ExactPoint): -1 | 0 | 1 {
  const determinant = (b[0] - a[0]) * (point[1] - a[1]) - (b[1] - a[1]) * (point[0] - a[0]);
  return determinant < 0n ? -1 : determinant > 0n ? 1 : 0;
}

function samePoint(a: ExactPoint, b: ExactPoint): boolean {
  return a[0] === b[0] && a[1] === b[1];
}

function minimum(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}

function maximum(a: bigint, b: bigint): bigint {
  return a > b ? a : b;
}

function classifyCollinear(a: ExactEdge, b: ExactEdge): Relation {
  const axis = a.start[0] === a.end[0] ? 1 : 0;
  const overlapStart = maximum(
    minimum(a.start[axis], a.end[axis]),
    minimum(b.start[axis], b.end[axis]),
  );
  const overlapEnd = minimum(
    maximum(a.start[axis], a.end[axis]),
    maximum(b.start[axis], b.end[axis]),
  );

  if (overlapStart > overlapEnd) return 'DISJOINT';
  if (overlapStart === overlapEnd) return 'COLLINEAR_POINT';
  if (samePoint(a.start, b.start) && samePoint(a.end, b.end)) return 'COINCIDENT_SAME';
  if (samePoint(a.start, b.end) && samePoint(a.end, b.start)) return 'COINCIDENT_REVERSED';
  return 'COLLINEAR_OVERLAP';
}

function classifyExact(a: ExactEdge, b: ExactEdge): Relation {
  const bStartAgainstA = orientation(a.start, a.end, b.start);
  const bEndAgainstA = orientation(a.start, a.end, b.end);
  const aStartAgainstB = orientation(b.start, b.end, a.start);
  const aEndAgainstB = orientation(b.start, b.end, a.end);

  if (bStartAgainstA === 0 && bEndAgainstA === 0 && aStartAgainstB === 0 && aEndAgainstB === 0) {
    return classifyCollinear(a, b);
  }

  const bStraddlesA = bStartAgainstA === 0 || bEndAgainstA === 0 || bStartAgainstA !== bEndAgainstA;
  const aStraddlesB = aStartAgainstB === 0 || aEndAgainstB === 0 || aStartAgainstB !== aEndAgainstB;
  if (!bStraddlesA || !aStraddlesB) return 'DISJOINT';

  const atAEndpoint = aStartAgainstB === 0 || aEndAgainstB === 0;
  const atBEndpoint = bStartAgainstA === 0 || bEndAgainstA === 0;
  if (atAEndpoint && atBEndpoint) return 'ENDPOINT_TOUCH';
  if (atAEndpoint || atBEndpoint) return 'T_JUNCTION';
  return 'PROPER_CROSSING';
}

function classifyCachedPair(a: CachedEdge, b: CachedEdge): Relation {
  return boxesAreDisjoint(a, b) ? 'DISJOINT' : classifyExact(a.exact, b.exact);
}

export function classifyPair(a: Edge, b: Edge): Relation {
  validateEdge(a, 'first edge');
  validateEdge(b, 'second edge');
  return classifyCachedPair(cacheEdge(a), cacheEdge(b));
}

function increment(counts: RelationCounts, relation: Relation): void {
  const next = counts[relation] + 1;
  if (!Number.isSafeInteger(next)) throw new Error(`${relation} count exceeds safe integer range`);
  counts[relation] = next;
}

function pairCount(edges: number): number {
  if (edges < 2) return 0;
  const pairs = (edges * (edges - 1)) / 2;
  if (!Number.isSafeInteger(pairs) || pairs < 0 || pairs > MAX_PAIRS) {
    throw new Error('edge pair count exceeds the classifier limit');
  }
  return pairs;
}

export function classifyEdges(edges: readonly Edge[]): Classification {
  const edgeCount = edges.length;
  if (!Number.isSafeInteger(edgeCount) || edgeCount < 0 || edgeCount > MAX_EDGES) {
    throw new Error(`edge count exceeds ${MAX_EDGES}`);
  }

  const pairs = pairCount(edgeCount);
  const cached = new Array<CachedEdge>(edgeCount);
  for (let index = 0; index < edgeCount; index += 1) {
    const edge = edges[index];
    if (edge === undefined) throw new Error(`edge ${index} is missing`);
    validateEdge(edge, `edge ${index}`);
    cached[index] = cacheEdge(edge);
  }

  const counts = emptyCounts();
  const adjacent = emptyCounts();
  const nonadjacent = emptyCounts();
  const first = emptyWitnesses();
  const contactHash = createHash('sha256').update(CONTACT_DOMAIN, 'utf8');
  let aabbRejected = 0;
  let exactTested = 0;

  for (let i = 0; i < edgeCount; i += 1) {
    const a = cached[i]!;
    for (let j = i + 1; j < edgeCount; j += 1) {
      const b = cached[j]!;
      const rejected = boxesAreDisjoint(a, b);
      const relation = rejected ? 'DISJOINT' : classifyExact(a.exact, b.exact);
      if (rejected) aabbRejected += 1;
      else exactTested += 1;

      const isAdjacent = j === i + 1 || (i === 0 && j === edgeCount - 1);
      increment(counts, relation);
      increment(isAdjacent ? adjacent : nonadjacent, relation);
      if (first[relation] === null) first[relation] = [i, j];
      if (relation !== 'DISJOINT') {
        contactHash.update(
          contactTuple(i, j, a.edge.rawIndex, b.edge.rawIndex, relation, isAdjacent),
        );
      }
    }
  }

  if (aabbRejected + exactTested !== pairs) {
    throw new Error('classifier pair accounting mismatch');
  }
  for (const relation of RELATIONS) {
    if (adjacent[relation] + nonadjacent[relation] !== counts[relation]) {
      throw new Error(`${relation} adjacency accounting mismatch`);
    }
  }

  return {
    edges: edgeCount,
    pairs,
    aabbRejected,
    exactTested,
    counts,
    adjacent,
    nonadjacent,
    first,
    contactSha256: contactHash.digest('hex'),
    peakCandidateRecords: 0,
  };
}
