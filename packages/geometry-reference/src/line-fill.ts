import type { Point } from './types.js';

export type LineFillRule = 'nonzero' | 'evenodd';
export type LineFillLocation = 'inside' | 'outside' | 'boundary';

type IntegerPoint = Readonly<{ x: bigint; y: bigint }>;
type Edge = readonly [start: IntegerPoint, end: IntegerPoint];

const MAX_CONTOURS = 256;
const MAX_VERTICES = 256;

function fail(message: string): never {
  throw new RangeError(message);
}

function isArray(value: unknown): boolean {
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

function cross(left: IntegerPoint, right: IntegerPoint): bigint {
  return left.x * right.y - left.y * right.x;
}

function subtract(left: IntegerPoint, right: IntegerPoint): IntegerPoint {
  return { x: left.x - right.x, y: left.y - right.y };
}

function orientation(start: IntegerPoint, end: IntegerPoint, point: IntegerPoint): bigint {
  return cross(subtract(end, start), subtract(point, start));
}

function isZero(vector: IntegerPoint): boolean {
  return vector.x === 0n && vector.y === 0n;
}

function onSegment(query: IntegerPoint, start: IntegerPoint, end: IntegerPoint): boolean {
  if (orientation(start, end, query) !== 0n) return false;
  return (
    query.x >= (start.x < end.x ? start.x : end.x) &&
    query.x <= (start.x > end.x ? start.x : end.x) &&
    query.y >= (start.y < end.y ? start.y : end.y) &&
    query.y <= (start.y > end.y ? start.y : end.y)
  );
}

function sign(value: bigint): -1 | 0 | 1 {
  return value < 0n ? -1 : value > 0n ? 1 : 0;
}

/** Sign of constant + epsilon * linear for positive infinitesimal epsilon. */
function infinitesimalSign(constant: bigint, linear: bigint): -1 | 0 | 1 {
  return constant === 0n ? sign(linear) : sign(constant);
}

function fillAtInfinitesimal(
  edges: readonly Edge[],
  query: IntegerPoint,
  direction: IntegerPoint,
  rule: LineFillRule,
): boolean {
  let winding = 0;
  let parity = 0;
  for (const [start, end] of edges) {
    const startY = infinitesimalSign(start.y - query.y, -direction.y);
    const endY = infinitesimalSign(end.y - query.y, -direction.y);
    const upward = startY <= 0 && endY > 0;
    const downward = startY > 0 && endY <= 0;
    if (!upward && !downward) continue;

    const edge = subtract(end, start);
    const side = infinitesimalSign(cross(edge, subtract(query, start)), cross(edge, direction));
    if ((upward && side > 0) || (downward && side < 0)) {
      parity ^= 1;
      winding += upward ? 1 : -1;
    }
  }
  return rule === 'nonzero' ? winding !== 0 : parity !== 0;
}

function upperHalf(vector: IntegerPoint): 0 | 1 {
  return vector.y > 0n || (vector.y === 0n && vector.x > 0n) ? 0 : 1;
}

function compareDirections(left: IntegerPoint, right: IntegerPoint): number {
  const leftHalf = upperHalf(left);
  const rightHalf = upperHalf(right);
  if (leftHalf !== rightHalf) return leftHalf - rightHalf;
  return -sign(cross(left, right));
}

function sectorDirection(start: IntegerPoint, end: IntegerPoint): IntegerPoint {
  const turn = cross(start, end);
  // A positive turn bounds the smaller CCW cone, so the sum lies inside it.
  // A negative turn bounds the reflex cone, so negate the sum; opposite rays
  // use the CCW perpendicular for their exactly half-plane sector.
  if (turn > 0n) return { x: start.x + end.x, y: start.y + end.y };
  if (turn < 0n) return { x: -start.x - end.x, y: -start.y - end.y };
  return { x: -start.y, y: start.x };
}

function classifyIncidentPoint(
  edges: readonly Edge[],
  query: IntegerPoint,
  incidentDirections: IntegerPoint[],
  rule: LineFillRule,
): LineFillLocation {
  incidentDirections.sort(compareDirections);
  const rays = incidentDirections.filter(
    (ray, index) =>
      index === 0 ||
      upperHalf(ray) !== upperHalf(incidentDirections[index - 1]!) ||
      cross(incidentDirections[index - 1]!, ray) !== 0n,
  );

  const sectors: IntegerPoint[] = [];
  if (rays.length === 1) {
    // A closed contour can expose one ray only by locally retracing it, so its
    // complement is one connected angular sector and needs one representative.
    sectors.push({ x: -rays[0]!.y, y: rays[0]!.x });
  } else {
    for (let index = 0; index < rays.length; index += 1) {
      sectors.push(sectorDirection(rays[index]!, rays[(index + 1) % rays.length]!));
    }
  }

  let hasFilled = false;
  let hasUnfilled = false;
  for (const direction of sectors) {
    if (fillAtInfinitesimal(edges, query, direction, rule)) hasFilled = true;
    else hasUnfilled = true;
    if (hasFilled && hasUnfilled) return 'boundary';
  }
  return hasFilled ? 'inside' : 'outside';
}

export function classifyLineFill(
  contours: readonly (readonly Point[])[],
  query: Point,
  rule: LineFillRule,
): LineFillLocation {
  if (rule !== 'nonzero' && rule !== 'evenodd') fail('invalid fill rule');
  if (!isArray(contours)) fail('contours must be an array');
  if (contours.length > MAX_CONTOURS) fail('too many contours');
  if (!isArray(query) || query.length !== 2) {
    fail('query must be a two-component point');
  }
  if (!Number.isFinite(query[0]) || !Number.isFinite(query[1])) fail('query must be finite');

  let vertexCount = 0;
  for (const contour of contours) {
    if (!isArray(contour)) fail('contour must be an array');
    vertexCount += contour.length;
    if (vertexCount > MAX_VERTICES) fail('too many vertices');
    for (const point of contour) {
      if (!isArray(point) || point.length !== 2) {
        fail('vertex must be a two-component point');
      }
      if (!Number.isFinite(point[0]) || !Number.isFinite(point[1])) {
        fail('vertex must be finite');
      }
    }
  }

  const bits = new DataView(new ArrayBuffer(8));
  const exactQuery = { x: toInteger(query[0], bits), y: toInteger(query[1], bits) };
  const edges: Edge[] = [];
  const incidentDirections: IntegerPoint[] = [];
  for (const contour of contours) {
    if (contour.length < 2) continue;
    const points = contour.map((point) => ({
      x: toInteger(point[0], bits),
      y: toInteger(point[1], bits),
    }));
    for (let index = 0; index < points.length; index += 1) {
      const start = points[index]!;
      const end = points[(index + 1) % points.length]!;
      if (start.x === end.x && start.y === end.y) continue;
      edges.push([start, end]);
      if (!onSegment(exactQuery, start, end)) continue;
      const toStart = subtract(start, exactQuery);
      const toEnd = subtract(end, exactQuery);
      if (!isZero(toStart)) incidentDirections.push(toStart);
      if (!isZero(toEnd)) incidentDirections.push(toEnd);
    }
  }

  if (incidentDirections.length > 0) {
    return classifyIncidentPoint(edges, exactQuery, incidentDirections, rule);
  }
  return fillAtInfinitesimal(edges, exactQuery, { x: 0n, y: 0n }, rule) ? 'inside' : 'outside';
}
