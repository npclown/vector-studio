import { inspectTriangleMesh } from './triangle-mesh.js';
import type { LineFillRule } from './line-fill.js';
import type { Point } from './types.js';
import type { TriangleMeshInput, TriangleMeshIssue } from './triangle-mesh.js';

export type LineFillMeshInput = Readonly<{
  contours: readonly (readonly Point[])[];
  rule: LineFillRule;
  mesh: TriangleMeshInput;
}>;

export type LineFillMeshInspection = Readonly<{
  valid: boolean;
  issue: TriangleMeshIssue | 'REGION_MISMATCH' | null;
}>;

type IntegerPoint = Readonly<{ x: bigint; y: bigint }>;
type Segment = readonly [start: IntegerPoint, end: IntegerPoint];
type Rational = Readonly<{ numerator: bigint; denominator: bigint }>;
type RationalPoint = Readonly<{ x: Rational; y: Rational }>;

const MAX_CONTOURS = 256;
const MAX_SOURCE_VERTICES = 32;
const MAX_COMBINED_EDGES = 32;
// Coordinates are integer multiples of 2^-1074, so this is exactly 1 locally.
const LOCAL_UNIT: Rational = { numerator: 1n << 1074n, denominator: 1n };

function fail(message: string): never {
  throw new RangeError(message);
}

function isArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

function sign(value: bigint): -1 | 0 | 1 {
  return value < 0n ? -1 : value > 0n ? 1 : 0;
}

function greatestCommonDivisor(left: bigint, right: bigint): bigint {
  let a = left < 0n ? -left : left;
  let b = right < 0n ? -right : right;
  while (b !== 0n) {
    const remainder = a % b;
    a = b;
    b = remainder;
  }
  return a;
}

function rational(numerator: bigint, denominator: bigint): Rational {
  if (denominator === 0n) fail('zero rational denominator');
  if (numerator === 0n) return { numerator: 0n, denominator: 1n };
  const divisor = greatestCommonDivisor(numerator, denominator);
  const denominatorSign = denominator < 0n ? -1n : 1n;
  return {
    numerator: (numerator / divisor) * denominatorSign,
    denominator: (denominator / divisor) * denominatorSign,
  };
}

function integerRational(value: bigint): Rational {
  return { numerator: value, denominator: 1n };
}

function compareRationals(left: Rational, right: Rational): number {
  return sign(left.numerator * right.denominator - right.numerator * left.denominator);
}

function midpoint(left: Rational, right: Rational): Rational {
  return rational(
    left.numerator * right.denominator + right.numerator * left.denominator,
    2n * left.denominator * right.denominator,
  );
}

function add(left: Rational, right: Rational): Rational {
  return rational(
    left.numerator * right.denominator + right.numerator * left.denominator,
    left.denominator * right.denominator,
  );
}

function subtract(left: Rational, right: Rational): Rational {
  return rational(
    left.numerator * right.denominator - right.numerator * left.denominator,
    left.denominator * right.denominator,
  );
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

function cross(left: IntegerPoint, right: IntegerPoint): bigint {
  return left.x * right.y - left.y * right.x;
}

function vector(start: IntegerPoint, end: IntegerPoint): IntegerPoint {
  return { x: end.x - start.x, y: end.y - start.y };
}

function isZeroLength(segment: Segment): boolean {
  return segment[0].x === segment[1].x && segment[0].y === segment[1].y;
}

function parameterIsClosed(numerator: bigint, denominator: bigint): boolean {
  return denominator > 0n
    ? numerator >= 0n && numerator <= denominator
    : numerator <= 0n && numerator >= denominator;
}

function intersectionX(left: Segment, right: Segment): Rational | null {
  const leftDirection = vector(left[0], left[1]);
  const rightDirection = vector(right[0], right[1]);
  const denominator = cross(leftDirection, rightDirection);
  if (denominator === 0n) return null;

  const betweenStarts = vector(left[0], right[0]);
  const leftNumerator = cross(betweenStarts, rightDirection);
  const rightNumerator = cross(betweenStarts, leftDirection);
  if (
    !parameterIsClosed(leftNumerator, denominator) ||
    !parameterIsClosed(rightNumerator, denominator)
  ) {
    return null;
  }

  return rational(left[0].x * denominator + leftDirection.x * leftNumerator, denominator);
}

function segmentCrossingY(segment: Segment, x: Rational): Rational | null {
  const [start, end] = segment;
  const direction = vector(start, end);
  if (direction.x === 0n) return null;

  const startComparison = start.x * x.denominator - x.numerator;
  const endComparison = end.x * x.denominator - x.numerator;
  if (!(
    (startComparison < 0n && endComparison > 0n) ||
    (startComparison > 0n && endComparison < 0n)
  )) {
    return null;
  }

  return rational(
    start.y * x.denominator * direction.x + (x.numerator - start.x * x.denominator) * direction.y,
    x.denominator * direction.x,
  );
}

function compareIntegerToRational(value: bigint, target: Rational): number {
  return sign(value * target.denominator - target.numerator);
}

function orientationAtRational(segment: Segment, query: RationalPoint): bigint {
  const [start, end] = segment;
  const direction = vector(start, end);
  return (
    direction.x * (query.y.numerator - start.y * query.y.denominator) * query.x.denominator -
    direction.y * (query.x.numerator - start.x * query.x.denominator) * query.y.denominator
  );
}

function containsPoint(
  edges: readonly Segment[],
  query: RationalPoint,
  rule: LineFillRule,
): boolean {
  let winding = 0;
  let parity = 0;
  for (const edge of edges) {
    const startY = compareIntegerToRational(edge[0].y, query.y);
    const endY = compareIntegerToRational(edge[1].y, query.y);
    const upward = startY <= 0 && endY > 0;
    const downward = startY > 0 && endY <= 0;
    if (!upward && !downward) continue;

    const side = orientationAtRational(edge, query);
    if ((upward && side > 0n) || (downward && side < 0n)) {
      parity ^= 1;
      winding += upward ? 1 : -1;
    }
  }
  return rule === 'nonzero' ? winding !== 0 : parity !== 0;
}

function sortedUnique(values: Rational[]): Rational[] {
  values.sort(compareRationals);
  return values.filter(
    (value, index) => index === 0 || compareRationals(values[index - 1]!, value) !== 0,
  );
}

function buildSourceEdges(contours: readonly (readonly Point[])[], bits: DataView): Segment[] {
  const edges: Segment[] = [];
  for (const contour of contours) {
    if (contour.length < 2) continue;
    const points: IntegerPoint[] = contour.map((point) => ({
      x: toInteger(point[0], bits),
      y: toInteger(point[1], bits),
    }));
    for (let index = 0; index < points.length; index += 1) {
      const edge: Segment = [points[index]!, points[(index + 1) % points.length]!];
      if (!isZeroLength(edge)) edges.push(edge);
    }
  }
  return edges;
}

function buildMeshEdges(mesh: TriangleMeshInput, bits: DataView): Segment[] {
  const points: IntegerPoint[] = mesh.vertices.map((point) => ({
    x: toInteger(point[0], bits),
    y: toInteger(point[1], bits),
  }));
  const edges: Segment[] = [];
  for (let offset = 0; offset < mesh.indices.length; offset += 3) {
    const first = points[mesh.indices[offset]!]!;
    const second = points[mesh.indices[offset + 1]!]!;
    const third = points[mesh.indices[offset + 2]!]!;
    edges.push([first, second], [second, third], [third, first]);
  }
  return edges;
}

function arrangementMatches(
  sourceEdges: readonly Segment[],
  meshEdges: readonly Segment[],
  rule: LineFillRule,
): boolean {
  const edges = [...sourceEdges, ...meshEdges];
  const xEvents: Rational[] = [];
  for (const edge of edges) {
    xEvents.push(integerRational(edge[0].x), integerRational(edge[1].x));
  }
  for (let left = 0; left < edges.length; left += 1) {
    for (let right = left + 1; right < edges.length; right += 1) {
      const x = intersectionX(edges[left]!, edges[right]!);
      if (x !== null) xEvents.push(x);
    }
  }

  const uniqueXEvents = sortedUnique(xEvents);
  for (let slab = 0; slab + 1 < uniqueXEvents.length; slab += 1) {
    const x = midpoint(uniqueXEvents[slab]!, uniqueXEvents[slab + 1]!);
    const yEvents = sortedUnique(
      edges.flatMap((edge) => {
        const y = segmentCrossingY(edge, x);
        return y === null ? [] : [y];
      }),
    );
    if (yEvents.length === 0) continue;

    const representatives: Rational[] = [subtract(yEvents[0]!, LOCAL_UNIT)];
    for (let cell = 0; cell + 1 < yEvents.length; cell += 1) {
      representatives.push(midpoint(yEvents[cell]!, yEvents[cell + 1]!));
    }
    representatives.push(add(yEvents[yEvents.length - 1]!, LOCAL_UNIT));

    for (const y of representatives) {
      const query = { x, y };
      if (containsPoint(sourceEdges, query, rule) !== containsPoint(meshEdges, query, 'nonzero')) {
        return false;
      }
    }
  }
  return true;
}

function invariantIssue(issue: TriangleMeshIssue): LineFillMeshInspection {
  return { valid: false, issue };
}

export function inspectLineFillMesh(input: LineFillMeshInput): LineFillMeshInspection {
  if (typeof input !== 'object' || input === null) fail('input must be an object');

  const { contours, rule, mesh } = input;
  if (!isArray(contours)) fail('contours must be an array');
  if (rule !== 'nonzero' && rule !== 'evenodd') fail('invalid fill rule');
  if (contours.length > MAX_CONTOURS) fail('too many contours');

  let sourceVertexCount = 0;
  for (const contour of contours) {
    if (!isArray(contour)) fail('contour must be an array');
    sourceVertexCount += contour.length;
    if (sourceVertexCount > MAX_SOURCE_VERTICES) fail('too many source vertices');
    for (const point of contour) {
      if (!isArray(point) || point.length !== 2) fail('vertex must be a two-coordinate array');
      if (!Number.isFinite(point[0]) || !Number.isFinite(point[1])) {
        fail('vertex coordinates must be finite');
      }
    }
  }

  const meshInspection = inspectTriangleMesh(mesh);
  if (sourceVertexCount + mesh.indices.length > MAX_COMBINED_EDGES) {
    fail('too many combined edges');
  }
  if (!meshInspection.valid) return invariantIssue(meshInspection.issue!);

  const bits = new DataView(new ArrayBuffer(8));
  const sourceEdges = buildSourceEdges(contours, bits);
  const meshEdges = buildMeshEdges(mesh, bits);
  if (!arrangementMatches(sourceEdges, meshEdges, rule)) {
    return { valid: false, issue: 'REGION_MISMATCH' };
  }
  return { valid: true, issue: null };
}
