import { bitsOf, exactInteger } from '../rounded-fill/exact.js';

export type ConformingMeshPoint = readonly [x: number, y: number];

export type ConformingMeshInput = Readonly<{
  vertices: readonly ConformingMeshPoint[];
  indices: readonly number[];
}>;

export type ConformingMeshLimits = Readonly<{
  maxVertices: number;
  maxInputTriangles: number;
  maxOutputTriangles: number;
  maxWork: number;
}>;

export const DEFAULT_LIMITS: ConformingMeshLimits = Object.freeze({
  maxVertices: 256,
  maxInputTriangles: 256,
  maxOutputTriangles: 512,
  maxWork: 2_000_000,
});

export type ConformingMeshStats = Readonly<{
  edgeVertexChecks: number;
  earChecks: number;
  emittedTriangles: number;
  work: number;
}>;

export type ConformingRefinementMesh = Readonly<{
  vertices: readonly ConformingMeshPoint[];
  indices: readonly number[];
  parentTriangle: readonly number[];
}>;

export type ConformingMeshResult =
  | Readonly<{
      ok: true;
      status: 'CERTIFIED';
      reason: null;
      stats: ConformingMeshStats;
      mesh: ConformingRefinementMesh;
    }>
  | Readonly<{
      ok: false;
      status: 'INVALID_INPUT' | 'WORK_LIMIT' | 'UNRESOLVED';
      reason: string;
      stats: ConformingMeshStats;
    }>;

type ExactPoint = readonly [x: bigint, y: bigint];
type ExactTriangle = readonly [a: ExactPoint, b: ExactPoint, c: ExactPoint];
type DecodedMesh = Readonly<{
  vertices: readonly ConformingMeshPoint[];
  exactVertices: readonly ExactPoint[];
  indices: readonly number[];
  triangles: readonly ExactTriangle[];
}>;

type MutableStats = {
  edgeVertexChecks: number;
  earChecks: number;
  emittedTriangles: number;
};

const LIMIT_KEYS = ['maxInputTriangles', 'maxOutputTriangles', 'maxVertices', 'maxWork'] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function exactPoint(point: ConformingMeshPoint): ExactPoint {
  return [exactInteger(bitsOf(point[0])), exactInteger(bitsOf(point[1]))];
}

function pointEquals(left: ExactPoint, right: ExactPoint): boolean {
  return left[0] === right[0] && left[1] === right[1];
}

function orient(a: ExactPoint, b: ExactPoint, c: ExactPoint): bigint {
  return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
}

function polygonDoubleArea(vertices: readonly number[], points: readonly ExactPoint[]): bigint {
  let area = 0n;
  for (let index = 0; index < vertices.length; index += 1) {
    const a = points[vertices[index]!]!;
    const b = points[vertices[(index + 1) % vertices.length]!]!;
    area += a[0] * b[1] - a[1] * b[0];
  }
  return area;
}

function strictOnSegment(point: ExactPoint, start: ExactPoint, end: ExactPoint): boolean {
  if (orient(start, end, point) !== 0n) return false;
  if (pointEquals(point, start) || pointEquals(point, end)) return false;
  return (
    point[0] >= (start[0] < end[0] ? start[0] : end[0]) &&
    point[0] <= (start[0] > end[0] ? start[0] : end[0]) &&
    point[1] >= (start[1] < end[1] ? start[1] : end[1]) &&
    point[1] <= (start[1] > end[1] ? start[1] : end[1])
  );
}

function closedOnSegment(point: ExactPoint, start: ExactPoint, end: ExactPoint): boolean {
  return (
    orient(start, end, point) === 0n &&
    point[0] >= (start[0] < end[0] ? start[0] : end[0]) &&
    point[0] <= (start[0] > end[0] ? start[0] : end[0]) &&
    point[1] >= (start[1] < end[1] ? start[1] : end[1]) &&
    point[1] <= (start[1] > end[1] ? start[1] : end[1])
  );
}

function compareOnDirectedSegment(
  left: number,
  right: number,
  start: ExactPoint,
  end: ExactPoint,
  points: readonly ExactPoint[],
): number {
  const axis = start[0] === end[0] ? 1 : 0;
  const direction = end[axis] > start[axis] ? 1 : -1;
  const leftValue = points[left]![axis];
  const rightValue = points[right]![axis];
  if (leftValue === rightValue) return left - right;
  return leftValue < rightValue ? -direction : direction;
}

function stats(value: MutableStats): ConformingMeshStats {
  return {
    edgeVertexChecks: value.edgeVertexChecks,
    earChecks: value.earChecks,
    emittedTriangles: value.emittedTriangles,
    work: value.edgeVertexChecks + value.earChecks,
  };
}

function failure(
  status: 'INVALID_INPUT' | 'WORK_LIMIT' | 'UNRESOLVED',
  reason: string,
  current: MutableStats,
): ConformingMeshResult {
  return { ok: false, status, reason, stats: stats(current) };
}

function validLimit(value: unknown, ceiling: number): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0 && Number(value) <= ceiling;
}

function decodeLimits(
  value: unknown,
): { ok: true; limits: ConformingMeshLimits } | { ok: false; reason: string } {
  if (!isRecord(value)) return { ok: false, reason: 'limits: expected an object' };
  const keys = Object.keys(value).sort();
  if (keys.length !== LIMIT_KEYS.length || keys.some((key, index) => key !== LIMIT_KEYS[index])) {
    return {
      ok: false,
      reason: 'limits: expected exactly maxVertices,maxInputTriangles,maxOutputTriangles,maxWork',
    };
  }
  if (!validLimit(value.maxVertices, DEFAULT_LIMITS.maxVertices)) {
    return { ok: false, reason: 'limits:maxVertices must be an integer from 1 through 256' };
  }
  if (!validLimit(value.maxInputTriangles, DEFAULT_LIMITS.maxInputTriangles)) {
    return {
      ok: false,
      reason: 'limits:maxInputTriangles must be an integer from 1 through 256',
    };
  }
  if (!validLimit(value.maxOutputTriangles, DEFAULT_LIMITS.maxOutputTriangles)) {
    return {
      ok: false,
      reason: 'limits:maxOutputTriangles must be an integer from 1 through 512',
    };
  }
  if (!validLimit(value.maxWork, DEFAULT_LIMITS.maxWork)) {
    return { ok: false, reason: 'limits:maxWork must be an integer from 1 through 2000000' };
  }
  return {
    ok: true,
    limits: {
      maxVertices: value.maxVertices,
      maxInputTriangles: value.maxInputTriangles,
      maxOutputTriangles: value.maxOutputTriangles,
      maxWork: value.maxWork,
    },
  };
}

function candidateTrianglesOverlap(left: ExactTriangle, right: ExactTriangle): boolean {
  for (let edge = 0; edge < 3; edge += 1) {
    const start = left[edge]!;
    const end = left[(edge + 1) % 3]!;
    if (right.every((point) => orient(start, end, point) <= 0n)) return false;
  }
  for (let edge = 0; edge < 3; edge += 1) {
    const start = right[edge]!;
    const end = right[(edge + 1) % 3]!;
    if (left.every((point) => orient(start, end, point) <= 0n)) return false;
  }
  return true;
}

function decodeCandidateMesh(
  value: unknown,
  limits: ConformingMeshLimits,
):
  | { ok: true; mesh: DecodedMesh }
  | { ok: false; status: 'INVALID_INPUT' | 'WORK_LIMIT'; reason: string } {
  if (!isRecord(value))
    return { ok: false, status: 'INVALID_INPUT', reason: 'input: expected a mesh object' };
  const rawVertices: unknown = value.vertices;
  const rawIndices: unknown = value.indices;
  if (!Array.isArray(rawVertices) || !Array.isArray(rawIndices)) {
    return {
      ok: false,
      status: 'INVALID_INPUT',
      reason: 'input: vertices and indices must be arrays',
    };
  }
  if (rawIndices.length % 3 !== 0) {
    return {
      ok: false,
      status: 'INVALID_INPUT',
      reason: 'indices:length must be divisible by 3',
    };
  }
  if (rawVertices.length > limits.maxVertices) {
    return {
      ok: false,
      status: 'WORK_LIMIT',
      reason: `input-limit: vertices exceed ${limits.maxVertices}`,
    };
  }
  const triangleCount = rawIndices.length / 3;
  if (triangleCount > limits.maxInputTriangles) {
    return {
      ok: false,
      status: 'WORK_LIMIT',
      reason: `input-limit: triangles exceed ${limits.maxInputTriangles}`,
    };
  }

  const vertices: ConformingMeshPoint[] = [];
  const exactVertices: ExactPoint[] = [];
  const coordinateOwner = new Map<string, number>();
  for (let index = 0; index < rawVertices.length; index += 1) {
    if (!Object.hasOwn(rawVertices, index)) {
      return { ok: false, status: 'INVALID_INPUT', reason: `vertices: sparse point at ${index}` };
    }
    const rawPoint: unknown = rawVertices[index];
    if (
      !Array.isArray(rawPoint) ||
      rawPoint.length !== 2 ||
      !Object.hasOwn(rawPoint, 0) ||
      !Object.hasOwn(rawPoint, 1) ||
      typeof rawPoint[0] !== 'number' ||
      typeof rawPoint[1] !== 'number' ||
      !Number.isFinite(rawPoint[0]) ||
      !Number.isFinite(rawPoint[1])
    ) {
      return {
        ok: false,
        status: 'INVALID_INPUT',
        reason: `vertices: point ${index} must contain two finite numbers`,
      };
    }
    const point: ConformingMeshPoint = [rawPoint[0], rawPoint[1]];
    const exact = exactPoint(point);
    const key = `${exact[0]},${exact[1]}`;
    const owner = coordinateOwner.get(key);
    if (owner !== undefined) {
      return {
        ok: false,
        status: 'INVALID_INPUT',
        reason: `vertices: duplicate geometric coordinates at ${owner},${index}`,
      };
    }
    coordinateOwner.set(key, index);
    vertices.push(point);
    exactVertices.push(exact);
  }

  const indices: number[] = [];
  for (let index = 0; index < rawIndices.length; index += 1) {
    if (!Object.hasOwn(rawIndices, index)) {
      return { ok: false, status: 'INVALID_INPUT', reason: `indices: sparse index at ${index}` };
    }
    const rawIndex: unknown = rawIndices[index];
    if (
      !Number.isSafeInteger(rawIndex) ||
      Number(rawIndex) < 0 ||
      Number(rawIndex) >= vertices.length
    ) {
      return {
        ok: false,
        status: 'INVALID_INPUT',
        reason: `indices: value ${index} must be an in-range integer`,
      };
    }
    indices.push(Number(rawIndex));
  }

  const triangles: ExactTriangle[] = [];
  for (let triangle = 0; triangle < triangleCount; triangle += 1) {
    const offset = triangle * 3;
    const exact: ExactTriangle = [
      exactVertices[indices[offset]!]!,
      exactVertices[indices[offset + 1]!]!,
      exactVertices[indices[offset + 2]!]!,
    ];
    if (orient(exact[0], exact[1], exact[2]) <= 0n) {
      return {
        ok: false,
        status: 'INVALID_INPUT',
        reason: `triangles: triangle ${triangle} is not strictly positive`,
      };
    }
    triangles.push(exact);
  }
  for (let left = 0; left < triangles.length; left += 1) {
    for (let right = left + 1; right < triangles.length; right += 1) {
      if (candidateTrianglesOverlap(triangles[left]!, triangles[right]!)) {
        return {
          ok: false,
          status: 'INVALID_INPUT',
          reason: `triangles: interiors overlap at ${left},${right}`,
        };
      }
    }
  }
  return { ok: true, mesh: { vertices, exactVertices, indices, triangles } };
}

function charge(
  current: MutableStats,
  kind: 'edge' | 'ear',
  limits: ConformingMeshLimits,
): boolean {
  if (current.edgeVertexChecks + current.earChecks >= limits.maxWork) return false;
  if (kind === 'edge') current.edgeVertexChecks += 1;
  else current.earChecks += 1;
  return true;
}

function candidateBoundaryPolygon(
  source: DecodedMesh,
  parent: number,
  limits: ConformingMeshLimits,
  current: MutableStats,
): { ok: true; polygon: number[] } | { ok: false; result: ConformingMeshResult } {
  const offset = parent * 3;
  const corners = [
    source.indices[offset]!,
    source.indices[offset + 1]!,
    source.indices[offset + 2]!,
  ];
  const polygon: number[] = [];
  for (let edge = 0; edge < 3; edge += 1) {
    const startIndex = corners[edge]!;
    const endIndex = corners[(edge + 1) % 3]!;
    const start = source.exactVertices[startIndex]!;
    const end = source.exactVertices[endIndex]!;
    const interior: number[] = [];
    for (let vertex = 0; vertex < source.exactVertices.length; vertex += 1) {
      if (!charge(current, 'edge', limits)) {
        return {
          ok: false,
          result: failure(
            'WORK_LIMIT',
            `work-limit: edge-vertex check exceeds ${limits.maxWork}`,
            current,
          ),
        };
      }
      if (strictOnSegment(source.exactVertices[vertex]!, start, end)) interior.push(vertex);
    }
    interior.sort((left, right) =>
      compareOnDirectedSegment(left, right, start, end, source.exactVertices),
    );
    polygon.push(startIndex, ...interior);
  }
  return { ok: true, polygon };
}

function appendCandidateTriangle(
  triangle: readonly [number, number, number],
  parent: number,
  limits: ConformingMeshLimits,
  current: MutableStats,
  outputIndices: number[],
  outputParents: number[],
): ConformingMeshResult | null {
  if (current.emittedTriangles >= limits.maxOutputTriangles) {
    return failure(
      'WORK_LIMIT',
      `output-limit: triangles exceed ${limits.maxOutputTriangles}`,
      current,
    );
  }
  outputIndices.push(...triangle);
  outputParents.push(parent);
  current.emittedTriangles += 1;
  return null;
}

export function refineConformingMesh(
  mesh: unknown,
  limits: unknown = DEFAULT_LIMITS,
): ConformingMeshResult {
  const current: MutableStats = { edgeVertexChecks: 0, earChecks: 0, emittedTriangles: 0 };
  const decodedLimits = decodeLimits(limits);
  if (!decodedLimits.ok) return failure('INVALID_INPUT', decodedLimits.reason, current);
  const decoded = decodeCandidateMesh(mesh, decodedLimits.limits);
  if (!decoded.ok) return failure(decoded.status, decoded.reason, current);

  const outputIndices: number[] = [];
  const outputParents: number[] = [];
  for (let parent = 0; parent < decoded.mesh.triangles.length; parent += 1) {
    const collected = candidateBoundaryPolygon(decoded.mesh, parent, decodedLimits.limits, current);
    if (!collected.ok) return collected.result;
    const polygon = collected.polygon;
    let remainingArea = polygonDoubleArea(polygon, decoded.mesh.exactVertices);
    if (polygon.length < 3 || remainingArea <= 0n) {
      return failure(
        'UNRESOLVED',
        `ear: parent ${parent} boundary polygon is not positive`,
        current,
      );
    }
    for (let index = 0; index < polygon.length; index += 1) {
      const a = decoded.mesh.exactVertices[polygon[index]!]!;
      const b = decoded.mesh.exactVertices[polygon[(index + 1) % polygon.length]!]!;
      const c = decoded.mesh.exactVertices[polygon[(index + 2) % polygon.length]!]!;
      if (orient(a, b, c) < 0n) {
        return failure(
          'UNRESOLVED',
          `ear: parent ${parent} boundary polygon is not weakly convex`,
          current,
        );
      }
    }

    while (polygon.length > 3) {
      let startPosition = 0;
      for (let position = 1; position < polygon.length; position += 1) {
        if (polygon[position]! < polygon[startPosition]!) startPosition = position;
      }
      let removed = false;
      for (let step = 0; step < polygon.length; step += 1) {
        const position = (startPosition + step) % polygon.length;
        if (!charge(current, 'ear', decodedLimits.limits)) {
          return failure(
            'WORK_LIMIT',
            `work-limit: ear check exceeds ${decodedLimits.limits.maxWork}`,
            current,
          );
        }
        const previous = polygon[(position + polygon.length - 1) % polygon.length]!;
        const selected = polygon[position]!;
        const next = polygon[(position + 1) % polygon.length]!;
        const earArea = orient(
          decoded.mesh.exactVertices[previous]!,
          decoded.mesh.exactVertices[selected]!,
          decoded.mesh.exactVertices[next]!,
        );
        if (earArea <= 0n || remainingArea - earArea <= 0n) continue;
        const appendFailure = appendCandidateTriangle(
          [previous, selected, next],
          parent,
          decodedLimits.limits,
          current,
          outputIndices,
          outputParents,
        );
        if (appendFailure) return appendFailure;
        polygon.splice(position, 1);
        remainingArea -= earArea;
        removed = true;
        break;
      }
      if (!removed) {
        return failure('UNRESOLVED', `ear: parent ${parent} has no eligible ear`, current);
      }
    }

    if (polygon.length !== 3) {
      return failure('UNRESOLVED', `ear: parent ${parent} has no final triangle`, current);
    }
    let first = 0;
    if (polygon[1]! < polygon[first]!) first = 1;
    if (polygon[2]! < polygon[first]!) first = 2;
    const finalTriangle: [number, number, number] = [
      polygon[first]!,
      polygon[(first + 1) % 3]!,
      polygon[(first + 2) % 3]!,
    ];
    if (
      orient(
        decoded.mesh.exactVertices[finalTriangle[0]]!,
        decoded.mesh.exactVertices[finalTriangle[1]]!,
        decoded.mesh.exactVertices[finalTriangle[2]]!,
      ) <= 0n
    ) {
      return failure('UNRESOLVED', `ear: parent ${parent} final triangle is not positive`, current);
    }
    const appendFailure = appendCandidateTriangle(
      finalTriangle,
      parent,
      decodedLimits.limits,
      current,
      outputIndices,
      outputParents,
    );
    if (appendFailure) return appendFailure;
  }

  return {
    ok: true,
    status: 'CERTIFIED',
    reason: null,
    stats: stats(current),
    mesh: {
      vertices: decoded.mesh.vertices.map(([x, y]) => [x, y]),
      indices: outputIndices,
      parentTriangle: outputParents,
    },
  };
}

function verifyFailure(stage: string, reason: string): never {
  throw new Error(`${stage}:${reason}`);
}

function decodeVerifierSource(value: unknown): DecodedMesh {
  if (!isRecord(value)) verifyFailure('source', 'expected a mesh object');
  const rawVertices: unknown = value.vertices;
  const rawIndices: unknown = value.indices;
  if (!Array.isArray(rawVertices) || !Array.isArray(rawIndices)) {
    verifyFailure('source', 'vertices and indices must be arrays');
  }
  if (rawIndices.length % 3 !== 0) verifyFailure('source-indices', 'length must be divisible by 3');
  if (rawVertices.length > DEFAULT_LIMITS.maxVertices) {
    verifyFailure('source-limit', 'vertices exceed 256');
  }
  if (rawIndices.length / 3 > DEFAULT_LIMITS.maxInputTriangles) {
    verifyFailure('source-limit', 'triangles exceed 256');
  }

  const vertices: ConformingMeshPoint[] = [];
  const exactVertices: ExactPoint[] = [];
  const owners = new Map<string, number>();
  for (let index = 0; index < rawVertices.length; index += 1) {
    if (!Object.hasOwn(rawVertices, index))
      verifyFailure('source-vertices', `sparse point ${index}`);
    const point: unknown = rawVertices[index];
    if (
      !Array.isArray(point) ||
      point.length !== 2 ||
      !Object.hasOwn(point, 0) ||
      !Object.hasOwn(point, 1) ||
      typeof point[0] !== 'number' ||
      typeof point[1] !== 'number' ||
      !Number.isFinite(point[0]) ||
      !Number.isFinite(point[1])
    ) {
      verifyFailure('source-vertices', `point ${index} must contain two finite numbers`);
    }
    const ordinary: ConformingMeshPoint = [point[0], point[1]];
    const exact = exactPoint(ordinary);
    const key = `${exact[0]},${exact[1]}`;
    const owner = owners.get(key);
    if (owner !== undefined) {
      verifyFailure('source-vertices', `duplicate geometric coordinates ${owner},${index}`);
    }
    owners.set(key, index);
    vertices.push(ordinary);
    exactVertices.push(exact);
  }

  const indices: number[] = [];
  for (let index = 0; index < rawIndices.length; index += 1) {
    if (!Object.hasOwn(rawIndices, index)) verifyFailure('source-indices', `sparse index ${index}`);
    const valueAtIndex: unknown = rawIndices[index];
    if (
      !Number.isSafeInteger(valueAtIndex) ||
      Number(valueAtIndex) < 0 ||
      Number(valueAtIndex) >= vertices.length
    ) {
      verifyFailure('source-indices', `value ${index} must be an in-range integer`);
    }
    indices.push(Number(valueAtIndex));
  }

  const triangles: ExactTriangle[] = [];
  for (let triangle = 0; triangle < indices.length / 3; triangle += 1) {
    const offset = triangle * 3;
    const exact: ExactTriangle = [
      exactVertices[indices[offset]!]!,
      exactVertices[indices[offset + 1]!]!,
      exactVertices[indices[offset + 2]!]!,
    ];
    if (orient(exact[0], exact[1], exact[2]) <= 0n) {
      verifyFailure('source-triangles', `triangle ${triangle} is not strictly positive`);
    }
    triangles.push(exact);
  }
  for (let left = 0; left < triangles.length; left += 1) {
    for (let right = left + 1; right < triangles.length; right += 1) {
      let separated = false;
      for (let edge = 0; edge < 3 && !separated; edge += 1) {
        const a = triangles[left]![edge]!;
        const b = triangles[left]![(edge + 1) % 3]!;
        separated = triangles[right]!.every((point) => orient(a, b, point) <= 0n);
      }
      for (let edge = 0; edge < 3 && !separated; edge += 1) {
        const a = triangles[right]![edge]!;
        const b = triangles[right]![(edge + 1) % 3]!;
        separated = triangles[left]!.every((point) => orient(a, b, point) <= 0n);
      }
      if (!separated) verifyFailure('source-triangles', `interiors overlap ${left},${right}`);
    }
  }
  return { vertices, exactVertices, indices, triangles };
}

type ProposedMesh = Readonly<{
  vertices: readonly ConformingMeshPoint[];
  indices: readonly number[];
  parentTriangle: readonly number[];
  triangles: readonly (readonly [number, number, number])[];
}>;

function decodeProposedMesh(value: unknown, source: DecodedMesh): ProposedMesh {
  if (!isRecord(value)) verifyFailure('proposed', 'expected a mesh object');
  const rawVertices: unknown = value.vertices;
  const rawIndices: unknown = value.indices;
  const rawParents: unknown = value.parentTriangle;
  if (!Array.isArray(rawVertices) || !Array.isArray(rawIndices) || !Array.isArray(rawParents)) {
    verifyFailure('proposed', 'vertices, indices and parentTriangle must be arrays');
  }
  if (rawVertices.length !== source.vertices.length) {
    verifyFailure('proposed-vertices', 'length differs from source');
  }
  for (let index = 0; index < rawVertices.length; index += 1) {
    if (!Object.hasOwn(rawVertices, index))
      verifyFailure('proposed-vertices', `sparse point ${index}`);
    const point: unknown = rawVertices[index];
    if (
      !Array.isArray(point) ||
      point.length !== 2 ||
      !Object.hasOwn(point, 0) ||
      !Object.hasOwn(point, 1) ||
      typeof point[0] !== 'number' ||
      typeof point[1] !== 'number' ||
      bitsOf(point[0]) !== bitsOf(source.vertices[index]![0]) ||
      bitsOf(point[1]) !== bitsOf(source.vertices[index]![1])
    ) {
      verifyFailure('proposed-vertices', `point ${index} differs from source bits`);
    }
  }
  if (rawIndices.length % 3 !== 0) {
    verifyFailure('proposed-indices', 'length must be divisible by 3');
  }
  const triangleCount = rawIndices.length / 3;
  if (triangleCount > DEFAULT_LIMITS.maxOutputTriangles) {
    verifyFailure('proposed-limit', 'triangles exceed 512');
  }
  if (rawParents.length !== triangleCount) {
    verifyFailure('proposed-parent', 'length must equal triangle count');
  }

  const indices: number[] = [];
  for (let index = 0; index < rawIndices.length; index += 1) {
    if (!Object.hasOwn(rawIndices, index))
      verifyFailure('proposed-indices', `sparse index ${index}`);
    const valueAtIndex: unknown = rawIndices[index];
    if (
      !Number.isSafeInteger(valueAtIndex) ||
      Number(valueAtIndex) < 0 ||
      Number(valueAtIndex) >= source.vertices.length
    ) {
      verifyFailure('proposed-indices', `value ${index} must be an in-range integer`);
    }
    indices.push(Number(valueAtIndex));
  }
  const parentTriangle: number[] = [];
  for (let index = 0; index < rawParents.length; index += 1) {
    if (!Object.hasOwn(rawParents, index))
      verifyFailure('proposed-parent', `sparse value ${index}`);
    const parent: unknown = rawParents[index];
    if (
      !Number.isSafeInteger(parent) ||
      Number(parent) < 0 ||
      Number(parent) >= source.triangles.length
    ) {
      verifyFailure('proposed-parent', `value ${index} must be an in-range integer`);
    }
    if (index > 0 && Number(parent) < parentTriangle[index - 1]!) {
      verifyFailure('proposed-parent', `values are not ordered at ${index}`);
    }
    parentTriangle.push(Number(parent));
  }

  const triangles: Array<readonly [number, number, number]> = [];
  for (let triangle = 0; triangle < triangleCount; triangle += 1) {
    const offset = triangle * 3;
    const tuple: readonly [number, number, number] = [
      indices[offset]!,
      indices[offset + 1]!,
      indices[offset + 2]!,
    ];
    if (
      orient(
        source.exactVertices[tuple[0]]!,
        source.exactVertices[tuple[1]]!,
        source.exactVertices[tuple[2]]!,
      ) <= 0n
    ) {
      verifyFailure('proposed-triangles', `triangle ${triangle} is not strictly positive`);
    }
    triangles.push(tuple);
  }
  return {
    vertices: rawVertices as ConformingMeshPoint[],
    indices,
    parentTriangle,
    triangles,
  };
}

function verifierTrianglesOverlap(
  left: readonly [number, number, number],
  right: readonly [number, number, number],
  points: readonly ExactPoint[],
): boolean {
  for (let side = 0; side < 6; side += 1) {
    const owner = side < 3 ? left : right;
    const other = side < 3 ? right : left;
    const edge = side % 3;
    const start = points[owner[edge]!]!;
    const end = points[owner[(edge + 1) % 3]!]!;
    let outside = true;
    for (const vertex of other) {
      if (orient(start, end, points[vertex]!) > 0n) {
        outside = false;
        break;
      }
    }
    if (outside) return false;
  }
  return true;
}

function addDirectedBoundary(map: Map<string, number>, from: number, to: number): void {
  const reverse = `${to}:${from}`;
  const reverseCount = map.get(reverse) ?? 0;
  if (reverseCount > 0) {
    if (reverseCount === 1) map.delete(reverse);
    else map.set(reverse, reverseCount - 1);
    return;
  }
  const forward = `${from}:${to}`;
  map.set(forward, (map.get(forward) ?? 0) + 1);
}

function verifierExpectedBoundary(source: DecodedMesh, parent: number): Map<string, number> {
  const expected = new Map<string, number>();
  const offset = parent * 3;
  const corners = [
    source.indices[offset]!,
    source.indices[offset + 1]!,
    source.indices[offset + 2]!,
  ];
  for (let edge = 0; edge < 3; edge += 1) {
    const startIndex = corners[edge]!;
    const endIndex = corners[(edge + 1) % 3]!;
    const start = source.exactVertices[startIndex]!;
    const end = source.exactVertices[endIndex]!;
    const sequence = [startIndex];
    for (let vertex = 0; vertex < source.exactVertices.length; vertex += 1) {
      if (strictOnSegment(source.exactVertices[vertex]!, start, end)) sequence.push(vertex);
    }
    sequence.sort((left, right) =>
      compareOnDirectedSegment(left, right, start, end, source.exactVertices),
    );
    sequence.push(endIndex);
    for (let index = 0; index + 1 < sequence.length; index += 1) {
      addDirectedBoundary(expected, sequence[index]!, sequence[index + 1]!);
    }
  }
  return expected;
}

function sameBoundaryMap(left: Map<string, number>, right: Map<string, number>): boolean {
  if (left.size !== right.size) return false;
  for (const [key, count] of left) if (right.get(key) !== count) return false;
  return true;
}

function compareAxis(left: ExactPoint, right: ExactPoint, axis: 0 | 1): number {
  if (left[axis] === right[axis]) return 0;
  return left[axis] < right[axis] ? -1 : 1;
}

function verifierSegmentsMayIntersect(
  aIndex: number,
  bIndex: number,
  cIndex: number,
  dIndex: number,
  points: readonly ExactPoint[],
): boolean {
  const a = points[aIndex]!;
  const b = points[bIndex]!;
  const c = points[cIndex]!;
  const d = points[dIndex]!;
  const abc = orient(a, b, c);
  const abd = orient(a, b, d);
  const cda = orient(c, d, a);
  const cdb = orient(c, d, b);
  if (abc === 0n && closedOnSegment(c, a, b)) return true;
  if (abd === 0n && closedOnSegment(d, a, b)) return true;
  if (cda === 0n && closedOnSegment(a, c, d)) return true;
  if (cdb === 0n && closedOnSegment(b, c, d)) return true;
  return abc < 0n !== abd < 0n && cda < 0n !== cdb < 0n;
}

function verifierIntersectionAllowed(
  left: readonly [number, number, number],
  right: readonly [number, number, number],
  points: readonly ExactPoint[],
): boolean {
  for (let leftEdge = 0; leftEdge < 3; leftEdge += 1) {
    const aIndex = left[leftEdge]!;
    const bIndex = left[(leftEdge + 1) % 3]!;
    for (let rightEdge = 0; rightEdge < 3; rightEdge += 1) {
      const cIndex = right[rightEdge]!;
      const dIndex = right[(rightEdge + 1) % 3]!;
      if (!verifierSegmentsMayIntersect(aIndex, bIndex, cIndex, dIndex, points)) continue;
      const sameEdge =
        (aIndex === cIndex && bIndex === dIndex) || (aIndex === dIndex && bIndex === cIndex);
      if (sameEdge) continue;
      const shared =
        aIndex === cIndex || aIndex === dIndex
          ? aIndex
          : bIndex === cIndex || bIndex === dIndex
            ? bIndex
            : null;
      if (shared === null) return false;

      const a = points[aIndex]!;
      const b = points[bIndex]!;
      const c = points[cIndex]!;
      const d = points[dIndex]!;
      if (orient(a, b, c) === 0n && orient(a, b, d) === 0n) {
        const axis: 0 | 1 = a[0] === b[0] ? 1 : 0;
        const leftLow = compareAxis(a, b, axis) <= 0 ? a : b;
        const leftHigh = leftLow === a ? b : a;
        const rightLow = compareAxis(c, d, axis) <= 0 ? c : d;
        const rightHigh = rightLow === c ? d : c;
        const low = compareAxis(leftLow, rightLow, axis) >= 0 ? leftLow : rightLow;
        const high = compareAxis(leftHigh, rightHigh, axis) <= 0 ? leftHigh : rightHigh;
        if (compareAxis(low, high, axis) < 0) return false;
      }
    }
  }
  return true;
}

export function verifyConformingRefinement(sourceValue: unknown, proposedValue: unknown): void {
  const source = decodeVerifierSource(sourceValue);
  const proposed = decodeProposedMesh(proposedValue, source);
  const byParent: Array<number[]> = Array.from({ length: source.triangles.length }, () => []);
  const areaByParent = Array<bigint>(source.triangles.length).fill(0n);

  for (let triangle = 0; triangle < proposed.triangles.length; triangle += 1) {
    const tuple = proposed.triangles[triangle]!;
    const parent = proposed.parentTriangle[triangle]!;
    const parentTriangle = source.triangles[parent]!;
    for (const vertex of tuple) {
      const point = source.exactVertices[vertex]!;
      if (
        orient(parentTriangle[0], parentTriangle[1], point) < 0n ||
        orient(parentTriangle[1], parentTriangle[2], point) < 0n ||
        orient(parentTriangle[2], parentTriangle[0], point) < 0n
      ) {
        verifyFailure('parent', `triangle ${triangle} is not contained in parent ${parent}`);
      }
    }
    areaByParent[parent]! += orient(
      source.exactVertices[tuple[0]]!,
      source.exactVertices[tuple[1]]!,
      source.exactVertices[tuple[2]]!,
    );
    byParent[parent]!.push(triangle);
  }

  for (let parent = 0; parent < source.triangles.length; parent += 1) {
    const expectedArea = orient(
      source.triangles[parent]![0],
      source.triangles[parent]![1],
      source.triangles[parent]![2],
    );
    if (areaByParent[parent] !== expectedArea) {
      verifyFailure('area', `parent ${parent} exact area differs`);
    }
    const children = byParent[parent]!;
    for (let left = 0; left < children.length; left += 1) {
      for (let right = left + 1; right < children.length; right += 1) {
        if (
          verifierTrianglesOverlap(
            proposed.triangles[children[left]!]!,
            proposed.triangles[children[right]!]!,
            source.exactVertices,
          )
        ) {
          verifyFailure('overlap', `parent ${parent} children ${left},${right} overlap`);
        }
      }
    }

    const actualBoundary = new Map<string, number>();
    for (const child of children) {
      const tuple = proposed.triangles[child]!;
      addDirectedBoundary(actualBoundary, tuple[0], tuple[1]);
      addDirectedBoundary(actualBoundary, tuple[1], tuple[2]);
      addDirectedBoundary(actualBoundary, tuple[2], tuple[0]);
    }
    const expectedBoundary = verifierExpectedBoundary(source, parent);
    if (!sameBoundaryMap(actualBoundary, expectedBoundary)) {
      verifyFailure('boundary', `parent ${parent} does not preserve every split boundary segment`);
    }
  }

  for (let left = 0; left < proposed.triangles.length; left += 1) {
    for (let right = left + 1; right < proposed.triangles.length; right += 1) {
      const leftTriangle = proposed.triangles[left]!;
      const rightTriangle = proposed.triangles[right]!;
      if (verifierTrianglesOverlap(leftTriangle, rightTriangle, source.exactVertices)) {
        verifyFailure('conformity', `triangle interiors overlap ${left},${right}`);
      }
      if (!verifierIntersectionAllowed(leftTriangle, rightTriangle, source.exactVertices)) {
        verifyFailure(
          'conformity',
          `triangle contact is not a common indexed vertex or edge ${left},${right}`,
        );
      }
    }
  }
}
