import { GEOMETRY_VERB, type GeometryRequest } from '../../packages/geometry-wasm/src/index.js';
import type { Cubic, Point } from '../../packages/geometry-reference/src/index.js';
import { createP2Workload } from '../geometry-benchmark/workload.js';
import type { DifferentialCase } from '../geometry/differential/index.js';

export type CensusSource = Readonly<{
  id: string;
  index: number;
  request: GeometryRequest;
  cubics: readonly Cubic[];
  expectedPreparation?: 'PREPARED' | 'KNOT_MISMATCH';
}>;

const point = (x: number, y: number): Point => [x, y];

function linear(start: Point, end: Point): Cubic {
  return [
    start,
    point((2 * start[0] + end[0]) / 3, (2 * start[1] + end[1]) / 3),
    point((start[0] + 2 * end[0]) / 3, (start[1] + 2 * end[1]) / 3),
    end,
  ];
}

function request(id: string, index: number, cubics: readonly Cubic[]): GeometryRequest {
  const verbs = new Uint8Array(1 + cubics.length);
  verbs[0] = GEOMETRY_VERB.MOVE;
  verbs.fill(GEOMETRY_VERB.CUBIC, 1);
  const points = new Float64Array(2 + cubics.length * 6);
  points.set(cubics[0]![0], 0);
  cubics.forEach((cubic, cubicIndex) => points.set(cubic.slice(1).flat(), 2 + cubicIndex * 6));
  return {
    domainId: 'p3-cubic-census',
    nodeId: id,
    requestId: index + 1,
    sourceEpoch: 1,
    sourceRevision: 1,
    verbs,
    points,
    strokeStyleHash: 'none',
    fillRule: 'nonzero',
    world: [1, 0, 0, 1],
    zoom: 1,
    devicePixelRatio: 1,
  };
}

function source(
  id: string,
  index: number,
  cubics: readonly Cubic[],
  expectedPreparation: CensusSource['expectedPreparation'],
): CensusSource {
  const base = { id, index, cubics, request: request(id, index, cubics) };
  return expectedPreparation === undefined ? base : { ...base, expectedPreparation };
}

export function smokeSources(): readonly CensusSource[] {
  const a = point(0, 0);
  const b = point(3, 0);
  const c = point(0, 3);
  const triangle = [linear(a, b), linear(b, c), linear(c, a)];
  const endpointRestoration: Cubic = [
    point(1, 0),
    point(3 / 4, 0),
    point(1 / 4, 0),
    point(2 ** -54, 0),
  ];
  const straight = Array.from({ length: 32 }, (_, index) =>
    linear(point(3 * index, 0), point(3 * index + 3, 0)),
  );
  const bowtieCorners = [point(0, 0), point(12, 12), point(0, 12), point(12, 0)];
  const bowtie = [
    linear(bowtieCorners[0]!, bowtieCorners[1]!),
    linear(bowtieCorners[1]!, bowtieCorners[2]!),
    linear(bowtieCorners[2]!, bowtieCorners[3]!),
  ];
  return [
    source('triangle', 0, triangle, 'PREPARED'),
    source('endpoint-restoration', 1, [endpointRestoration], 'KNOT_MISMATCH'),
    source('straight-32', 2, straight, 'PREPARED'),
    source('bowtie-implicit-close', 3, bowtie, 'PREPARED'),
  ];
}

function cubicsFromRequest(request: GeometryRequest): readonly Cubic[] {
  const cubics: Cubic[] = [];
  let current: Point = [request.points[0]!, request.points[1]!];
  for (let ordinal = 1; ordinal < request.verbs.length; ordinal += 1) {
    if (request.verbs[ordinal] !== GEOMETRY_VERB.CUBIC)
      throw new Error(`workload ${request.nodeId} has a non-cubic verb`);
    const offset = 2 + (ordinal - 1) * 6;
    const cubic: Cubic = [
      current,
      [request.points[offset]!, request.points[offset + 1]!],
      [request.points[offset + 2]!, request.points[offset + 3]!],
      [request.points[offset + 4]!, request.points[offset + 5]!],
    ];
    cubics.push(cubic);
    current = cubic[3];
  }
  return cubics;
}

export function fullSources(): readonly CensusSource[] {
  return createP2Workload().requests.map((item, index) => ({
    id: item.nodeId,
    index,
    request: item,
    cubics: cubicsFromRequest(item),
  }));
}

export function differentialCase(source: CensusSource): DifferentialCase {
  const request = source.request;
  return {
    id: `p3-census/${source.id}`,
    category: 'edge',
    input: {
      requests: [
        {
          requestId: request.requestId,
          sourceEpoch: request.sourceEpoch,
          sourceRevision: request.sourceRevision,
          bucketTolerance: 1 / 8,
        },
      ],
      pathOffsets: [0, request.verbs.length],
      pointOffsets: [0, request.points.length],
      verbs: request.verbs,
      points: request.points,
    },
    metadata: { scenario: 'p3-cubic-readiness-census/v1', source: source.id },
    expectedBatchStatus: 0,
    paths: [
      {
        status: 0,
        cubics: source.cubics.map((cubic, index) => ({
          cubic,
          sourceVerbOrdinal: index + 1,
        })),
        screen: [1, 0, 0, 1],
      },
    ],
  };
}
