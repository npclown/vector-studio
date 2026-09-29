import type { Point } from './types.js';

export type TriangleMeshInput = Readonly<{
  vertices: readonly Point[];
  indices: readonly number[];
  bounds: readonly [minX: number, minY: number, maxX: number, maxY: number];
  expectedArea?: number;
}>;

export type TriangleMeshIssue =
  | 'DEGENERATE_TRIANGLE'
  | 'REVERSED_TRIANGLE'
  | 'BOUNDS_MISMATCH'
  | 'OVERLAPPING_TRIANGLES'
  | 'AREA_MISMATCH';

export type TriangleMeshInspection = Readonly<{
  valid: boolean;
  issue: TriangleMeshIssue | null;
}>;

type IntegerPoint = Readonly<{ x: bigint; y: bigint }>;
type IntegerTriangle = readonly [IntegerPoint, IntegerPoint, IntegerPoint];
type IntegerBounds = readonly [minX: bigint, minY: bigint, maxX: bigint, maxY: bigint];

const MAX_VERTICES = 256;
const MAX_TRIANGLES = 256;
const BINARY64_UNIT_EXPONENT = 1074n;

function fail(message: string): never {
  throw new RangeError(message);
}

function isArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

/** Return the exact binary64 value as an integer multiple of 2^-1074. */
function toInteger(value: number, bits: DataView): bigint {
  bits.setFloat64(0, value, false);
  const high = bits.getUint32(0, false);
  const low = bits.getUint32(4, false);
  const exponent = (high >>> 20) & 0x7ff;
  const fraction = (BigInt(high & 0xfffff) << 32n) | BigInt(low);
  if (exponent === 0) {
    return (high & 0x80000000) === 0 ? fraction : -fraction;
  }
  const significand = (1n << 52n) | fraction;
  const magnitude = significand << BigInt(exponent - 1);
  return (high & 0x80000000) === 0 ? magnitude : -magnitude;
}

function orientation(start: IntegerPoint, end: IntegerPoint, point: IntegerPoint): bigint {
  return (end.x - start.x) * (point.y - start.y) - (end.y - start.y) * (point.x - start.x);
}

function hasSeparatingEdge(source: IntegerTriangle, other: IntegerTriangle): boolean {
  for (let edge = 0; edge < 3; edge += 1) {
    const start = source[edge]!;
    const end = source[(edge + 1) % 3]!;
    // Positive triangle interiors lie in the open left half-plane. Letting all
    // other vertices satisfy <= 0 admits shared edges and boundary-only contact.
    if (
      orientation(start, end, other[0]) <= 0n &&
      orientation(start, end, other[1]) <= 0n &&
      orientation(start, end, other[2]) <= 0n
    ) {
      return true;
    }
  }
  return false;
}

function interiorsOverlap(left: IntegerTriangle, right: IntegerTriangle): boolean {
  return !hasSeparatingEdge(left, right) && !hasSeparatingEdge(right, left);
}

function issue(issue: TriangleMeshIssue): TriangleMeshInspection {
  return { valid: false, issue };
}

export function inspectTriangleMesh(input: TriangleMeshInput): TriangleMeshInspection {
  if (typeof input !== 'object' || input === null) fail('input must be an object');

  const { vertices, indices, bounds, expectedArea } = input;
  if (!isArray(vertices)) fail('vertices must be an array');
  if (!isArray(indices)) fail('indices must be an array');
  if (!isArray(bounds) || bounds.length !== 4) fail('bounds must contain four coordinates');

  if (vertices.length > MAX_VERTICES) fail('too many vertices');
  if (indices.length % 3 !== 0) fail('indices must contain complete triangles');
  if (indices.length / 3 > MAX_TRIANGLES) fail('too many triangles');

  for (const vertex of vertices) {
    if (!isArray(vertex) || vertex.length !== 2) fail('vertex must be a two-coordinate array');
    if (!Number.isFinite(vertex[0]) || !Number.isFinite(vertex[1])) {
      fail('vertex coordinates must be finite');
    }
  }

  for (const index of indices) {
    if (!Number.isInteger(index) || index < 0 || index >= vertices.length) {
      fail('index must be an in-range integer');
    }
  }

  for (const coordinate of bounds) {
    if (!Number.isFinite(coordinate)) fail('bounds coordinates must be finite');
  }
  if (bounds[0] > bounds[2] || bounds[1] > bounds[3]) fail('bounds must be ordered');

  if (expectedArea !== undefined) {
    if (!Number.isFinite(expectedArea) || expectedArea < 0) {
      fail('expected area must be finite and nonnegative');
    }
  }

  const bits = new DataView(new ArrayBuffer(8));
  const exactVertices: IntegerPoint[] = vertices.map((vertex) => ({
    x: toInteger(vertex[0], bits),
    y: toInteger(vertex[1], bits),
  }));
  const exactBounds: IntegerBounds = [
    toInteger(bounds[0], bits),
    toInteger(bounds[1], bits),
    toInteger(bounds[2], bits),
    toInteger(bounds[3], bits),
  ];

  const triangles: IntegerTriangle[] = [];
  const twiceAreas: bigint[] = [];
  for (let offset = 0; offset < indices.length; offset += 3) {
    const triangle: IntegerTriangle = [
      exactVertices[indices[offset]!]!,
      exactVertices[indices[offset + 1]!]!,
      exactVertices[indices[offset + 2]!]!,
    ];
    const twiceArea = orientation(triangle[0], triangle[1], triangle[2]);
    if (twiceArea === 0n) return issue('DEGENERATE_TRIANGLE');
    if (twiceArea < 0n) return issue('REVERSED_TRIANGLE');
    triangles.push(triangle);
    twiceAreas.push(twiceArea);
  }

  for (const vertex of exactVertices) {
    if (
      vertex.x < exactBounds[0] ||
      vertex.y < exactBounds[1] ||
      vertex.x > exactBounds[2] ||
      vertex.y > exactBounds[3]
    ) {
      return issue('BOUNDS_MISMATCH');
    }
  }

  for (let leftIndex = 0; leftIndex < triangles.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < triangles.length; rightIndex += 1) {
      if (interiorsOverlap(triangles[leftIndex]!, triangles[rightIndex]!)) {
        return issue('OVERLAPPING_TRIANGLES');
      }
    }
  }

  if (expectedArea !== undefined) {
    let totalTwiceArea = 0n;
    for (const twiceArea of twiceAreas) totalTwiceArea += twiceArea;
    const exactExpectedArea = toInteger(expectedArea, bits);
    const expectedTwiceArea = exactExpectedArea * 2n * (1n << BINARY64_UNIT_EXPONENT);
    if (totalTwiceArea !== expectedTwiceArea) return issue('AREA_MISMATCH');
  }

  return { valid: true, issue: null };
}
