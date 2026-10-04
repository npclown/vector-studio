import { classifyLineFill } from '../../../packages/geometry-reference/src/line-fill.js';
import type {
  Cubic,
  Point,
  ReferenceFlattenedLine,
} from '../../../packages/geometry-reference/src/types.js';
import {
  add,
  compare,
  div,
  exactNumber,
  mul,
  rational,
  sign,
  sub,
  ZERO,
  type Rational,
} from '../rounded-fill/exact.js';

export type SimpleCubicTopologyStatus =
  | 'CERTIFIED'
  | 'INVALID_LIMITS'
  | 'INVALID_INPUT'
  | 'INVALID_PROVENANCE'
  | 'KNOT_MISMATCH'
  | 'UNRESOLVED'
  | 'WORK_LIMIT';

export type CubicTopologySegment = Readonly<{
  cubic: Cubic;
  sourceVerbOrdinal: number;
  lines: readonly ReferenceFlattenedLine[];
}>;

export type SimpleCubicTopologyLimits = Readonly<{
  maxContours?: number;
  maxCubics?: number;
  maxLeaves?: number;
  maxPairs?: number;
}>;

export type SimpleCubicTopologyCertificate = Readonly<{
  polygons: readonly (readonly Point[])[];
  orientations: readonly (-1 | 1)[];
  winding: readonly (readonly (-1 | 0 | 1)[])[];
}>;

export type SimpleCubicTopologyResult = Readonly<{
  ok: boolean;
  status: SimpleCubicTopologyStatus;
  leaves: number;
  pairs: number;
  finding: string | null;
  certificate: SimpleCubicTopologyCertificate | null;
}>;

export type TransverseArrangementCrossing = Readonly<{
  leftLeaf: number;
  rightLeaf: number;
  orientation: -1 | 1;
}>;

export type TransverseArrangementCertificate = Readonly<{
  polygons: readonly (readonly Point[])[];
  crossings: readonly TransverseArrangementCrossing[];
}>;

export type TransverseArrangementResult = Readonly<{
  ok: boolean;
  status: SimpleCubicTopologyStatus;
  leaves: number;
  pairs: number;
  finding: string | null;
  certificate: TransverseArrangementCertificate | null;
}>;

export type CubicPreparationStatus =
  | 'PREPARED'
  | 'INVALID_INPUT'
  | 'INVALID_PROVENANCE'
  | 'KNOT_MISMATCH'
  | 'PROJECTION_UNRESOLVED'
  | 'WORK_LIMIT';

export type CubicPreparationFindingCode =
  | 'CONTOUR_SHAPE'
  | 'SEGMENT_SHAPE'
  | 'LINE_SHAPE'
  | 'SOURCE_CAP'
  | 'LINE_CAP'
  | 'CUBIC'
  | 'ORDINAL'
  | 'CONNECTIVITY'
  | 'ENDPOINT'
  | 'PROVENANCE'
  | 'KNOT'
  | 'PROJECTION';

export type CubicPreparationFinding = Readonly<{
  code: CubicPreparationFindingCode;
  segmentIndex: number | null;
  sourceVerbOrdinal: number | null;
  lineIndex: number | null;
  endpoint: 'start' | 'end' | null;
}>;

export type CubicPreparationResult = Readonly<{
  status: CubicPreparationStatus;
  finding: CubicPreparationFinding | null;
}>;

type ExactPoint = readonly [x: Rational, y: Rational];
type ExactCubic = readonly [p0: ExactPoint, p1: ExactPoint, p2: ExactPoint, p3: ExactPoint];
type CheckedLimits = Readonly<{
  maxContours: number;
  maxCubics: number;
  maxLeaves: number;
  maxPairs: number;
}>;
type ProvenanceLine = Readonly<{
  ordinaryEnd: Point;
  exactEnd: ExactPoint;
  start: Rational;
  end: Rational;
}>;
type PreparedSegment = Readonly<{
  cubic: Cubic;
  exactCubic: ExactCubic;
  lines: readonly ProvenanceLine[];
}>;
type PreparedContour = readonly PreparedSegment[];
type TopologyPreflight =
  | Readonly<{ ok: false; result: TopologyFailureResult }>
  | Readonly<{
      ok: true;
      limits: CheckedLimits;
      contours: readonly PreparedContour[];
    }>;
type SuccessfulTopologyPreflight = Extract<TopologyPreflight, Readonly<{ ok: true }>>;
type PreparedSourceKinds = readonly (readonly boolean[])[];
type SourceKindsValidation =
  | Readonly<{ ok: false; result: TopologyFailureResult }>
  | Readonly<{ ok: true; kinds: PreparedSourceKinds }>;
type ShapedLine = Readonly<{ end: Point; provenance: unknown }>;
type ShapedSegment = Readonly<{
  cubic: Cubic;
  sourceVerbOrdinal: number;
  lines: readonly ShapedLine[];
}>;
type StructuredSegment = Readonly<{
  record: Record<string, unknown>;
  lines: readonly unknown[];
}>;
type PreparationLine = Readonly<{
  exactEnd: ExactPoint;
  start: Rational;
  end: Rational;
}>;
type PreparationSegment = Readonly<{
  exactCubic: ExactCubic;
  sourceVerbOrdinal: number;
  lines: readonly PreparationLine[];
}>;
type RestrictedLeaf = Readonly<{
  controls: ExactCubic;
  exactStart: ExactPoint;
  exactEnd: ExactPoint;
  ordinaryStart: Point;
  ordinaryEnd: Point;
}>;
type LeafHull = Readonly<{
  contour: number;
  contourLeaf: number;
  hull: readonly ExactPoint[];
  start: ExactPoint;
  end: ExactPoint;
  ordinaryStart: Point;
}>;
type RoundedLeaf = Readonly<{
  contour: number;
  contourLeaf: number;
  hull: readonly ExactPoint[];
  start: ExactPoint;
  end: ExactPoint;
  ordinaryStart: Point;
  sourceStart: ExactPoint;
  sourceEnd: ExactPoint;
  sourceDifferences: readonly ExactPoint[];
}>;
type TopologyFailureResult = Readonly<{
  ok: false;
  status: Exclude<SimpleCubicTopologyStatus, 'CERTIFIED'>;
  leaves: number;
  pairs: number;
  finding: string;
  certificate: null;
}>;
type RoundedTopologyPreparation =
  | Readonly<{ ok: false; result: TopologyFailureResult }>
  | Readonly<{
      ok: true;
      limits: CheckedLimits;
      leaves: readonly RoundedLeaf[];
      contourLeafCounts: readonly number[];
    }>;

const MAX_CONTOURS = 4;
const MAX_CUBICS = 16;
const MAX_LEAVES = 64;
const MAX_PAIRS = 2016;
const MAX_PROVENANCE_DEPTH = 20;
const MAX_U32 = 0xffff_ffff;
const MAX_PREPARATION_CUBICS = 32;
const MAX_PREPARATION_LINES = 4096;
const UNIT = rational(1n, 1n << 1074n);
const ONE = rational(1n);

function failure(
  status: Exclude<SimpleCubicTopologyStatus, 'CERTIFIED'>,
  finding: string,
  leaves = 0,
  pairs = 0,
): TopologyFailureResult {
  return { ok: false, status, leaves, pairs, finding, certificate: null };
}

function success(
  leaves: number,
  pairs: number,
  certificate: SimpleCubicTopologyCertificate,
): SimpleCubicTopologyResult {
  return { ok: true, status: 'CERTIFIED', leaves, pairs, finding: null, certificate };
}

function preparationFailure(
  status: Exclude<CubicPreparationStatus, 'PREPARED'>,
  code: CubicPreparationFindingCode,
  segmentIndex: number | null = null,
  sourceVerbOrdinal: number | null = null,
  lineIndex: number | null = null,
  endpoint: 'start' | 'end' | null = null,
): CubicPreparationResult {
  return {
    status,
    finding: { code, segmentIndex, sourceVerbOrdinal, lineIndex, endpoint },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isUnknownArray(value: unknown): value is readonly unknown[] {
  return Array.isArray(value);
}

function hasIndex(value: readonly unknown[], index: number): boolean {
  return Object.prototype.hasOwnProperty.call(value, index);
}

function isFinitePoint(value: unknown): value is Point {
  if (!isUnknownArray(value) || value.length !== 2) return false;
  for (let index = 0; index < 2; index += 1) {
    if (!hasIndex(value, index)) return false;
    const component: unknown = value[index];
    if (typeof component !== 'number' || !Number.isFinite(component)) return false;
  }
  return true;
}

function isPointShape(value: unknown): value is readonly [unknown, unknown] {
  return isUnknownArray(value) && value.length === 2 && hasIndex(value, 0) && hasIndex(value, 1);
}

function isFiniteCubic(value: unknown): value is Cubic {
  if (!isUnknownArray(value) || value.length !== 4) return false;
  for (let index = 0; index < 4; index += 1) {
    if (!hasIndex(value, index) || !isFinitePoint(value[index])) return false;
  }
  return true;
}

function validLimit(value: unknown, minimum: number, maximum: number): value is number {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    Number.isSafeInteger(value) &&
    value >= minimum &&
    value <= maximum
  );
}

function readLimits(
  limits: unknown,
): Readonly<{ ok: false; finding: string }> | Readonly<{ ok: true; limits: CheckedLimits }> {
  if (limits !== undefined && !isRecord(limits)) {
    return { ok: false, finding: 'limits must be an object' };
  }
  const supplied = limits;
  const maxContours = supplied && 'maxContours' in supplied ? supplied.maxContours : MAX_CONTOURS;
  const maxCubics = supplied && 'maxCubics' in supplied ? supplied.maxCubics : MAX_CUBICS;
  const maxLeaves = supplied && 'maxLeaves' in supplied ? supplied.maxLeaves : MAX_LEAVES;
  const maxPairs = supplied && 'maxPairs' in supplied ? supplied.maxPairs : MAX_PAIRS;
  if (!validLimit(maxContours, 1, MAX_CONTOURS)) {
    return { ok: false, finding: 'maxContours must be a safe integer from 1 through 4' };
  }
  if (!validLimit(maxCubics, 1, MAX_CUBICS)) {
    return { ok: false, finding: 'maxCubics must be a safe integer from 1 through 16' };
  }
  if (!validLimit(maxLeaves, 1, MAX_LEAVES)) {
    return { ok: false, finding: 'maxLeaves must be a safe integer from 1 through 64' };
  }
  if (!validLimit(maxPairs, 0, MAX_PAIRS)) {
    return { ok: false, finding: 'maxPairs must be a safe integer from 0 through 2016' };
  }
  return { ok: true, limits: { maxContours, maxCubics, maxLeaves, maxPairs } };
}

function decodeOrdinaryNumber(value: number): Rational {
  return mul(exactNumber(value), UNIT);
}

function exactPoint(point: Point): ExactPoint {
  return [decodeOrdinaryNumber(point[0]), decodeOrdinaryNumber(point[1])];
}

function exactCubic(cubic: Cubic): ExactCubic {
  return [exactPoint(cubic[0]), exactPoint(cubic[1]), exactPoint(cubic[2]), exactPoint(cubic[3])];
}

function equalPoint(left: ExactPoint, right: ExactPoint): boolean {
  return compare(left[0], right[0]) === 0 && compare(left[1], right[1]) === 0;
}

function equalOrdinaryPoint(left: Point, right: Point): boolean {
  return left[0] === right[0] && left[1] === right[1];
}

function pointSub(left: ExactPoint, right: ExactPoint): ExactPoint {
  return [sub(left[0], right[0]), sub(left[1], right[1])];
}

function pointAdd(left: ExactPoint, right: ExactPoint): ExactPoint {
  return [add(left[0], right[0]), add(left[1], right[1])];
}

function pointScale(point: ExactPoint, scalar: Rational): ExactPoint {
  return [mul(point[0], scalar), mul(point[1], scalar)];
}

function dot(left: ExactPoint, right: ExactPoint): Rational {
  return add(mul(left[0], right[0]), mul(left[1], right[1]));
}

function crossVectors(left: ExactPoint, right: ExactPoint): Rational {
  return sub(mul(left[0], right[1]), mul(left[1], right[0]));
}

function orient(start: ExactPoint, end: ExactPoint, query: ExactPoint): Rational {
  return crossVectors(pointSub(end, start), pointSub(query, start));
}

function lerp(left: ExactPoint, right: ExactPoint, t: Rational): ExactPoint {
  return pointAdd(pointScale(left, sub(ONE, t)), pointScale(right, t));
}

function splitCubic(cubic: ExactCubic, t: Rational): readonly [ExactCubic, ExactCubic] {
  const p01 = lerp(cubic[0], cubic[1], t);
  const p12 = lerp(cubic[1], cubic[2], t);
  const p23 = lerp(cubic[2], cubic[3], t);
  const p012 = lerp(p01, p12, t);
  const p123 = lerp(p12, p23, t);
  const p0123 = lerp(p012, p123, t);
  return [
    [cubic[0], p01, p012, p0123],
    [p0123, p123, p23, cubic[3]],
  ];
}

function restrictCubic(cubic: ExactCubic, start: Rational, end: Rational): ExactCubic {
  const right = compare(start, ZERO) === 0 ? cubic : splitCubic(cubic, start)[1];
  const localEnd = div(sub(end, start), sub(ONE, start));
  return compare(localEnd, ONE) === 0 ? right : splitCubic(right, localEnd)[0];
}

function comparePoints(left: ExactPoint, right: ExactPoint): number {
  const x = compare(left[0], right[0]);
  return x === 0 ? compare(left[1], right[1]) : x;
}

function convexHull(points: readonly ExactPoint[]): readonly ExactPoint[] {
  const sorted = [...points].sort(comparePoints);
  const unique = sorted.filter(
    (point, index) => index === 0 || !equalPoint(point, sorted[index - 1]!),
  );
  if (unique.length <= 2) return unique;

  const lower: ExactPoint[] = [];
  for (const point of unique) {
    while (
      lower.length >= 2 &&
      compare(orient(lower[lower.length - 2]!, lower[lower.length - 1]!, point), ZERO) <= 0
    ) {
      lower.pop();
    }
    lower.push(point);
  }
  const upper: ExactPoint[] = [];
  for (let index = unique.length - 1; index >= 0; index -= 1) {
    const point = unique[index]!;
    while (
      upper.length >= 2 &&
      compare(orient(upper[upper.length - 2]!, upper[upper.length - 1]!, point), ZERO) <= 0
    ) {
      upper.pop();
    }
    upper.push(point);
  }
  lower.pop();
  upper.pop();
  return [...lower, ...upper];
}

function betweenClosed(value: Rational, left: Rational, right: Rational): boolean {
  const minimum = compare(left, right) <= 0 ? left : right;
  const maximum = compare(left, right) >= 0 ? left : right;
  return compare(value, minimum) >= 0 && compare(value, maximum) <= 0;
}

function onSegment(query: ExactPoint, start: ExactPoint, end: ExactPoint): boolean {
  return (
    compare(orient(start, end, query), ZERO) === 0 &&
    betweenClosed(query[0], start[0], end[0]) &&
    betweenClosed(query[1], start[1], end[1])
  );
}

function hullEdges(hull: readonly ExactPoint[]): readonly (readonly [ExactPoint, ExactPoint])[] {
  if (hull.length < 2) return [];
  if (hull.length === 2) return [[hull[0]!, hull[1]!]];
  return hull.map((point, index) => [point, hull[(index + 1) % hull.length]!] as const);
}

function segmentsIntersect(a: ExactPoint, b: ExactPoint, c: ExactPoint, d: ExactPoint): boolean {
  const abc = sign(orient(a, b, c));
  const abd = sign(orient(a, b, d));
  const cda = sign(orient(c, d, a));
  const cdb = sign(orient(c, d, b));
  if (abc === 0 && onSegment(c, a, b)) return true;
  if (abd === 0 && onSegment(d, a, b)) return true;
  if (cda === 0 && onSegment(a, c, d)) return true;
  if (cdb === 0 && onSegment(b, c, d)) return true;
  return abc !== 0 && abd !== 0 && abc !== abd && cda !== 0 && cdb !== 0 && cda !== cdb;
}

function pointInClosedHull(query: ExactPoint, hull: readonly ExactPoint[]): boolean {
  if (hull.length === 0) return false;
  if (hull.length === 1) return equalPoint(query, hull[0]!);
  if (hull.length === 2) return onSegment(query, hull[0]!, hull[1]!);
  return hull.every(
    (point, index) => compare(orient(point, hull[(index + 1) % hull.length]!, query), ZERO) >= 0,
  );
}

function closedHullsIntersect(left: readonly ExactPoint[], right: readonly ExactPoint[]): boolean {
  for (const [a, b] of hullEdges(left)) {
    for (const [c, d] of hullEdges(right)) {
      if (segmentsIntersect(a, b, c, d)) return true;
    }
  }
  return pointInClosedHull(left[0]!, right) || pointInClosedHull(right[0]!, left);
}

function segmentIntersectionHasPointOtherThan(
  a: ExactPoint,
  b: ExactPoint,
  c: ExactPoint,
  d: ExactPoint,
  allowed: ExactPoint,
): boolean {
  if (!segmentsIntersect(a, b, c, d)) return false;
  const collinear = compare(orient(a, b, c), ZERO) === 0 && compare(orient(a, b, d), ZERO) === 0;
  if (!collinear) return !(onSegment(allowed, a, b) && onSegment(allowed, c, d));
  for (const point of [a, b, c, d]) {
    if (!equalPoint(point, allowed) && onSegment(point, a, b) && onSegment(point, c, d)) {
      return true;
    }
  }
  return false;
}

function hullIntersectionIsOnly(
  left: readonly ExactPoint[],
  right: readonly ExactPoint[],
  allowed: ExactPoint,
): boolean {
  if (!pointInClosedHull(allowed, left) || !pointInClosedHull(allowed, right)) return false;
  for (const point of left) {
    if (!equalPoint(point, allowed) && pointInClosedHull(point, right)) return false;
  }
  for (const point of right) {
    if (!equalPoint(point, allowed) && pointInClosedHull(point, left)) return false;
  }
  for (const [a, b] of hullEdges(left)) {
    for (const [c, d] of hullEdges(right)) {
      if (segmentIntersectionHasPointOtherThan(a, b, c, d, allowed)) return false;
    }
  }
  return true;
}

function projectedMonotone(controls: ExactCubic): boolean {
  const chord = pointSub(controls[3], controls[0]);
  if (compare(dot(chord, chord), ZERO) === 0) return false;
  const projections = [
    dot(pointSub(controls[1], controls[0]), chord),
    dot(pointSub(controls[2], controls[1]), chord),
    dot(pointSub(controls[3], controls[2]), chord),
  ];
  return (
    projections.every((projection) => compare(projection, ZERO) >= 0) &&
    projections.some((projection) => compare(projection, ZERO) > 0)
  );
}

function polygonOrientation(points: readonly ExactPoint[]): -1 | 0 | 1 {
  let twiceArea = ZERO;
  for (let index = 0; index < points.length; index += 1) {
    const current = points[index]!;
    const next = points[(index + 1) % points.length]!;
    twiceArea = add(twiceArea, sub(mul(current[0], next[1]), mul(current[1], next[0])));
  }
  return sign(twiceArea);
}

function adjacentSharedPoint(
  left: LeafHull,
  right: LeafHull,
  contourLeafCounts: readonly number[],
): ExactPoint | null {
  if (left.contour !== right.contour) return null;
  const count = contourLeafCounts[left.contour]!;
  if (right.contourLeaf === left.contourLeaf + 1) return left.end;
  if (left.contourLeaf === 0 && right.contourLeaf === count - 1) return left.start;
  return null;
}

function cubicDifferences(controls: ExactCubic): readonly ExactPoint[] {
  return [
    pointSub(controls[1], controls[0]),
    pointSub(controls[2], controls[1]),
    pointSub(controls[3], controls[2]),
  ];
}

function roundedLeafProgresses(leaf: RoundedLeaf, direction: ExactPoint): boolean {
  let total = ZERO;
  for (const difference of leaf.sourceDifferences) {
    const projection = dot(difference, direction);
    if (compare(projection, ZERO) < 0) return false;
    total = add(total, projection);
  }
  return (
    compare(total, ZERO) > 0 && compare(dot(pointSub(leaf.end, leaf.start), direction), ZERO) > 0
  );
}

function directedCyclicAdjacent(
  left: RoundedLeaf,
  right: RoundedLeaf,
  contourLeafCounts: readonly number[],
): readonly [previous: RoundedLeaf, next: RoundedLeaf] | null {
  if (left.contour !== right.contour) return null;
  const count = contourLeafCounts[left.contour]!;
  if (right.contourLeaf === left.contourLeaf + 1) return [left, right];
  if (left.contourLeaf === 0 && right.contourLeaf === count - 1) return [right, left];
  return null;
}

function segmentsProperlyIntersect(
  a: ExactPoint,
  b: ExactPoint,
  c: ExactPoint,
  d: ExactPoint,
): boolean {
  const abc = sign(orient(a, b, c));
  const abd = sign(orient(a, b, d));
  const cda = sign(orient(c, d, a));
  const cdb = sign(orient(c, d, b));
  return abc !== 0 && abd !== 0 && abc !== abd && cda !== 0 && cdb !== 0 && cda !== cdb;
}

function transverseGenerators(leaf: RoundedLeaf): readonly ExactPoint[] {
  // Cubic source differences omit their positive factor of three only for sign comparisons.
  // True-closure and explicitly marked affine-LINE differences are already their constant
  // derivatives. Retain the duplicate chord generator in every case, as required by the
  // derivative-cone proof.
  return [...leaf.sourceDifferences, pointSub(leaf.end, leaf.start)];
}

function endpointSweepsDisjoint(leaf: RoundedLeaf, otherHull: readonly ExactPoint[]): boolean {
  const startSweep = convexHull([leaf.sourceStart, leaf.start]);
  if (closedHullsIntersect(startSweep, otherHull)) return false;
  const endSweep = convexHull([leaf.sourceEnd, leaf.end]);
  return !closedHullsIntersect(endSweep, otherHull);
}

function certifyTransverseRoundedPair(left: RoundedLeaf, right: RoundedLeaf): -1 | 1 | null {
  if (!segmentsProperlyIntersect(left.start, left.end, right.start, right.end)) return null;

  const leftGenerators = transverseGenerators(left);
  const rightGenerators = transverseGenerators(right);
  let orientation: -1 | 1 | null = null;
  for (const leftGenerator of leftGenerators) {
    for (const rightGenerator of rightGenerators) {
      const current = sign(crossVectors(leftGenerator, rightGenerator));
      if (current === 0) return null;
      if (orientation === null) orientation = current;
      else if (orientation !== current) return null;
    }
  }

  if (!endpointSweepsDisjoint(left, right.hull) || !endpointSweepsDisjoint(right, left.hull)) {
    return null;
  }
  return orientation;
}

/**
 * Checks only the bounded exact preparation needed by the P3 cubic census.
 * A prepared result makes no claim about closure, hulls, or fill topology.
 */
export function inspectCubicPreparation(
  segments: readonly CubicTopologySegment[],
): CubicPreparationResult {
  const runtimeSegments: unknown = segments;
  if (!isUnknownArray(runtimeSegments) || runtimeSegments.length === 0) {
    return preparationFailure('INVALID_INPUT', 'CONTOUR_SHAPE');
  }
  if (runtimeSegments.length > MAX_PREPARATION_CUBICS) {
    return preparationFailure('WORK_LIMIT', 'SOURCE_CAP', MAX_PREPARATION_CUBICS);
  }

  let declaredLines = 0;
  const structured: StructuredSegment[] = [];
  for (let segmentIndex = 0; segmentIndex < runtimeSegments.length; segmentIndex += 1) {
    if (!hasIndex(runtimeSegments, segmentIndex)) {
      return preparationFailure('INVALID_INPUT', 'SEGMENT_SHAPE', segmentIndex);
    }
    const candidate: unknown = runtimeSegments[segmentIndex];
    if (!isRecord(candidate) || !isUnknownArray(candidate.lines)) {
      return preparationFailure('INVALID_INPUT', 'SEGMENT_SHAPE', segmentIndex);
    }
    if (candidate.lines.length === 0) {
      return preparationFailure('INVALID_INPUT', 'LINE_SHAPE', segmentIndex);
    }
    const remainingLines = MAX_PREPARATION_LINES - declaredLines;
    if (candidate.lines.length > remainingLines) {
      return preparationFailure('WORK_LIMIT', 'LINE_CAP', segmentIndex, null, remainingLines);
    }
    declaredLines += candidate.lines.length;
    structured.push({ record: candidate, lines: candidate.lines });
  }

  for (let segmentIndex = 0; segmentIndex < structured.length; segmentIndex += 1) {
    const segment = structured[segmentIndex]!;
    for (let lineIndex = 0; lineIndex < segment.lines.length; lineIndex += 1) {
      if (!hasIndex(segment.lines, lineIndex)) {
        return preparationFailure('INVALID_INPUT', 'LINE_SHAPE', segmentIndex, null, lineIndex);
      }
      const line: unknown = segment.lines[lineIndex];
      if (!isRecord(line) || !isPointShape(line.end)) {
        return preparationFailure('INVALID_INPUT', 'LINE_SHAPE', segmentIndex, null, lineIndex);
      }
    }
  }

  const numericSegments: Readonly<{
    cubic: Cubic;
    ordinal: unknown;
    lines: readonly Readonly<{ end: Point; provenance: unknown }>[];
  }>[] = [];
  for (let segmentIndex = 0; segmentIndex < structured.length; segmentIndex += 1) {
    const segment = structured[segmentIndex]!;
    if (!isFiniteCubic(segment.record.cubic)) {
      return preparationFailure('INVALID_INPUT', 'CUBIC', segmentIndex);
    }
    const ordinal = segment.record.sourceVerbOrdinal;
    const findingOrdinal =
      typeof ordinal === 'number' &&
      Number.isSafeInteger(ordinal) &&
      ordinal >= 0 &&
      ordinal <= MAX_U32
        ? ordinal
        : null;
    const lines: Readonly<{ end: Point; provenance: unknown }>[] = [];
    for (let lineIndex = 0; lineIndex < segment.lines.length; lineIndex += 1) {
      const line = segment.lines[lineIndex] as Record<string, unknown>;
      if (!isFinitePoint(line.end)) {
        return preparationFailure(
          'INVALID_INPUT',
          'ENDPOINT',
          segmentIndex,
          findingOrdinal,
          lineIndex,
          'end',
        );
      }
      lines.push({ end: [line.end[0], line.end[1]], provenance: line.provenance });
    }
    numericSegments.push({
      cubic: segment.record.cubic,
      ordinal,
      lines,
    });
  }

  const ordinals = new Set<number>();
  const shaped: ShapedSegment[] = [];
  let previousEnd: Point | null = null;
  for (let segmentIndex = 0; segmentIndex < numericSegments.length; segmentIndex += 1) {
    const segment = numericSegments[segmentIndex]!;
    const ordinal = segment.ordinal;
    if (
      typeof ordinal !== 'number' ||
      !Number.isSafeInteger(ordinal) ||
      ordinal < 0 ||
      ordinal > MAX_U32
    ) {
      return preparationFailure('INVALID_INPUT', 'ORDINAL', segmentIndex);
    }
    if (ordinals.has(ordinal)) {
      return preparationFailure('INVALID_INPUT', 'ORDINAL', segmentIndex, ordinal);
    }
    ordinals.add(ordinal);
    if (previousEnd && !equalOrdinaryPoint(previousEnd, segment.cubic[0])) {
      return preparationFailure('INVALID_INPUT', 'CONNECTIVITY', segmentIndex, ordinal);
    }
    previousEnd = segment.cubic[3];
    shaped.push({
      cubic: segment.cubic,
      sourceVerbOrdinal: ordinal,
      lines: segment.lines,
    });
  }

  const prepared: PreparationSegment[] = [];
  for (let segmentIndex = 0; segmentIndex < shaped.length; segmentIndex += 1) {
    const segment = shaped[segmentIndex]!;
    const lines: PreparationLine[] = [];
    let previousNumerator = 0n;
    let previousDenominator = 1n;
    for (let lineIndex = 0; lineIndex < segment.lines.length; lineIndex += 1) {
      const line = segment.lines[lineIndex]!;
      const provenance: unknown = line.provenance;
      if (!isRecord(provenance)) {
        return preparationFailure(
          'INVALID_PROVENANCE',
          'PROVENANCE',
          segmentIndex,
          segment.sourceVerbOrdinal,
          lineIndex,
        );
      }
      const source = provenance.sourceVerbOrdinal;
      const numerator = provenance.endNumerator;
      const depth = provenance.depth;
      if (
        source !== segment.sourceVerbOrdinal ||
        typeof depth !== 'number' ||
        !Number.isSafeInteger(depth) ||
        depth < 0 ||
        depth > MAX_PROVENANCE_DEPTH ||
        typeof numerator !== 'number' ||
        !Number.isSafeInteger(numerator) ||
        numerator < 1 ||
        numerator > 2 ** depth
      ) {
        return preparationFailure(
          'INVALID_PROVENANCE',
          'PROVENANCE',
          segmentIndex,
          segment.sourceVerbOrdinal,
          lineIndex,
        );
      }
      const denominator = 1n << BigInt(depth);
      const endNumerator = BigInt(numerator);
      const startNumerator = endNumerator - 1n;
      if (previousNumerator * denominator !== startNumerator * previousDenominator) {
        return preparationFailure(
          'INVALID_PROVENANCE',
          'PROVENANCE',
          segmentIndex,
          segment.sourceVerbOrdinal,
          lineIndex,
        );
      }
      lines.push({
        exactEnd: exactPoint(line.end),
        start: rational(startNumerator, denominator),
        end: rational(endNumerator, denominator),
      });
      previousNumerator = endNumerator;
      previousDenominator = denominator;
    }
    if (previousNumerator !== previousDenominator) {
      return preparationFailure(
        'INVALID_PROVENANCE',
        'PROVENANCE',
        segmentIndex,
        segment.sourceVerbOrdinal,
        segment.lines.length - 1,
      );
    }
    prepared.push({
      exactCubic: exactCubic(segment.cubic),
      sourceVerbOrdinal: segment.sourceVerbOrdinal,
      lines,
    });
  }

  for (let segmentIndex = 0; segmentIndex < prepared.length; segmentIndex += 1) {
    const segment = prepared[segmentIndex]!;
    let actualStart = segment.exactCubic[0];
    for (let lineIndex = 0; lineIndex < segment.lines.length; lineIndex += 1) {
      const line = segment.lines[lineIndex]!;
      const controls = restrictCubic(segment.exactCubic, line.start, line.end);
      if (!equalPoint(actualStart, controls[0])) {
        return preparationFailure(
          'KNOT_MISMATCH',
          'KNOT',
          segmentIndex,
          segment.sourceVerbOrdinal,
          lineIndex,
          'start',
        );
      }
      if (!equalPoint(line.exactEnd, controls[3])) {
        return preparationFailure(
          'KNOT_MISMATCH',
          'KNOT',
          segmentIndex,
          segment.sourceVerbOrdinal,
          lineIndex,
          'end',
        );
      }
      actualStart = line.exactEnd;
    }
  }

  for (let segmentIndex = 0; segmentIndex < prepared.length; segmentIndex += 1) {
    const segment = prepared[segmentIndex]!;
    for (let lineIndex = 0; lineIndex < segment.lines.length; lineIndex += 1) {
      const line = segment.lines[lineIndex]!;
      const controls = restrictCubic(segment.exactCubic, line.start, line.end);
      if (!projectedMonotone(controls)) {
        return preparationFailure(
          'PROJECTION_UNRESOLVED',
          'PROJECTION',
          segmentIndex,
          segment.sourceVerbOrdinal,
          lineIndex,
        );
      }
    }
  }

  return { status: 'PREPARED', finding: null };
}

function prepareTopologyInput(
  contours: readonly (readonly CubicTopologySegment[])[],
  limits: SimpleCubicTopologyLimits | undefined,
): TopologyPreflight {
  const checkedLimits = readLimits(limits);
  if (!checkedLimits.ok) {
    return { ok: false, result: failure('INVALID_LIMITS', checkedLimits.finding) };
  }
  const bounded = checkedLimits.limits;

  const runtimeContours: unknown = contours;
  if (!isUnknownArray(runtimeContours) || runtimeContours.length === 0) {
    return {
      ok: false,
      result: failure('INVALID_INPUT', 'contours must be a nonempty array'),
    };
  }
  if (runtimeContours.length > bounded.maxContours) {
    return {
      ok: false,
      result: failure('WORK_LIMIT', `input exceeds ${bounded.maxContours} contours`),
    };
  }

  let cubicCount = 0;
  const runtimeContourArrays: (readonly unknown[])[] = [];
  for (let contourIndex = 0; contourIndex < runtimeContours.length; contourIndex += 1) {
    if (!hasIndex(runtimeContours, contourIndex)) {
      return {
        ok: false,
        result: failure('INVALID_INPUT', `contour ${contourIndex} is missing`),
      };
    }
    const contour: unknown = runtimeContours[contourIndex];
    if (!isUnknownArray(contour) || contour.length === 0) {
      return {
        ok: false,
        result: failure('INVALID_INPUT', `contour ${contourIndex} must be a nonempty array`),
      };
    }
    cubicCount += contour.length;
    if (cubicCount > bounded.maxCubics) {
      return {
        ok: false,
        result: failure('WORK_LIMIT', `input exceeds ${bounded.maxCubics} source cubics`),
      };
    }
    runtimeContourArrays.push(contour);
  }

  let declaredLeaves = 0;
  const structuredContours: StructuredSegment[][] = [];
  for (let contourIndex = 0; contourIndex < runtimeContourArrays.length; contourIndex += 1) {
    const contour = runtimeContourArrays[contourIndex]!;
    const structured: StructuredSegment[] = [];
    for (let segmentIndex = 0; segmentIndex < contour.length; segmentIndex += 1) {
      if (!hasIndex(contour, segmentIndex)) {
        return {
          ok: false,
          result: failure(
            'INVALID_INPUT',
            `contour ${contourIndex} source segment ${segmentIndex} is missing`,
          ),
        };
      }
      const candidate: unknown = contour[segmentIndex];
      if (!isRecord(candidate) || !isUnknownArray(candidate.lines)) {
        return {
          ok: false,
          result: failure(
            'INVALID_INPUT',
            `contour ${contourIndex} source segment ${segmentIndex} must contain a lines array`,
          ),
        };
      }
      declaredLeaves += candidate.lines.length;
      if (declaredLeaves > bounded.maxLeaves) {
        return {
          ok: false,
          result: failure(
            'WORK_LIMIT',
            `input declares more than ${bounded.maxLeaves} source lines`,
          ),
        };
      }
      if (candidate.lines.length === 0) {
        return {
          ok: false,
          result: failure(
            'INVALID_INPUT',
            `contour ${contourIndex} source segment ${segmentIndex} must emit at least one line`,
          ),
        };
      }
      structured.push({ record: candidate, lines: candidate.lines });
    }
    structuredContours.push(structured);
  }

  const ordinals = new Set<number>();
  const shapedContours: ShapedSegment[][] = [];
  for (let contourIndex = 0; contourIndex < structuredContours.length; contourIndex += 1) {
    const contour = structuredContours[contourIndex]!;
    const shaped: ShapedSegment[] = [];
    let previousEnd: Point | null = null;
    for (let segmentIndex = 0; segmentIndex < contour.length; segmentIndex += 1) {
      const candidate = contour[segmentIndex]!;
      if (!isFiniteCubic(candidate.record.cubic)) {
        return {
          ok: false,
          result: failure(
            'INVALID_INPUT',
            `contour ${contourIndex} source segment ${segmentIndex} must contain a finite cubic`,
          ),
        };
      }
      const ordinal: unknown = candidate.record.sourceVerbOrdinal;
      if (
        typeof ordinal !== 'number' ||
        !Number.isSafeInteger(ordinal) ||
        ordinal < 0 ||
        ordinal > MAX_U32
      ) {
        return {
          ok: false,
          result: failure(
            'INVALID_INPUT',
            `contour ${contourIndex} source segment ${segmentIndex} ordinal must be u32`,
          ),
        };
      }
      if (ordinals.has(ordinal)) {
        return {
          ok: false,
          result: failure('INVALID_INPUT', `source ordinal ${ordinal} is duplicated`),
        };
      }
      ordinals.add(ordinal);
      if (previousEnd && !equalOrdinaryPoint(previousEnd, candidate.record.cubic[0])) {
        return {
          ok: false,
          result: failure(
            'INVALID_INPUT',
            `contour ${contourIndex} source segment ${segmentIndex} is disconnected`,
          ),
        };
      }
      previousEnd = candidate.record.cubic[3];
      const shapedLines: ShapedLine[] = [];
      for (let lineIndex = 0; lineIndex < candidate.lines.length; lineIndex += 1) {
        if (!hasIndex(candidate.lines, lineIndex)) {
          return {
            ok: false,
            result: failure(
              'INVALID_INPUT',
              `contour ${contourIndex} source segment ${segmentIndex} line ${lineIndex} is missing`,
            ),
          };
        }
        const line: unknown = candidate.lines[lineIndex];
        if (!isRecord(line) || !isFinitePoint(line.end)) {
          return {
            ok: false,
            result: failure(
              'INVALID_INPUT',
              `contour ${contourIndex} source segment ${segmentIndex} line ${lineIndex} must have a finite endpoint`,
            ),
          };
        }
        shapedLines.push({
          end: [line.end[0], line.end[1]],
          provenance: line.provenance,
        });
      }
      shaped.push({
        cubic: candidate.record.cubic,
        sourceVerbOrdinal: ordinal,
        lines: shapedLines,
      });
    }
    shapedContours.push(shaped);
  }

  const preparedContours: PreparedContour[] = [];
  for (let contourIndex = 0; contourIndex < shapedContours.length; contourIndex += 1) {
    const contour = shapedContours[contourIndex]!;
    const prepared: PreparedSegment[] = [];
    for (let segmentIndex = 0; segmentIndex < contour.length; segmentIndex += 1) {
      const segment = contour[segmentIndex]!;
      const provenanceLines: ProvenanceLine[] = [];
      let previousNumerator = 0n;
      let previousDenominator = 1n;
      for (let lineIndex = 0; lineIndex < segment.lines.length; lineIndex += 1) {
        const line = segment.lines[lineIndex]!;
        const provenance: unknown = line.provenance;
        if (!isRecord(provenance)) {
          return {
            ok: false,
            result: failure(
              'INVALID_PROVENANCE',
              `contour ${contourIndex} source segment ${segmentIndex} line ${lineIndex} lacks provenance`,
            ),
          };
        }
        const source = provenance.sourceVerbOrdinal;
        const numerator = provenance.endNumerator;
        const depth = provenance.depth;
        if (source !== segment.sourceVerbOrdinal) {
          return {
            ok: false,
            result: failure(
              'INVALID_PROVENANCE',
              `contour ${contourIndex} source segment ${segmentIndex} line ${lineIndex} has the wrong ordinal`,
            ),
          };
        }
        if (
          typeof depth !== 'number' ||
          !Number.isSafeInteger(depth) ||
          depth < 0 ||
          depth > MAX_PROVENANCE_DEPTH ||
          typeof numerator !== 'number' ||
          !Number.isSafeInteger(numerator) ||
          numerator < 1 ||
          numerator > 2 ** depth
        ) {
          return {
            ok: false,
            result: failure(
              'INVALID_PROVENANCE',
              `contour ${contourIndex} source segment ${segmentIndex} line ${lineIndex} has invalid dyadic provenance`,
            ),
          };
        }
        const denominator = 1n << BigInt(depth);
        const endNumerator = BigInt(numerator);
        const startNumerator = endNumerator - 1n;
        if (previousNumerator * denominator !== startNumerator * previousDenominator) {
          return {
            ok: false,
            result: failure(
              'INVALID_PROVENANCE',
              `contour ${contourIndex} source segment ${segmentIndex} line ${lineIndex} is not adjacent`,
            ),
          };
        }
        provenanceLines.push({
          ordinaryEnd: [line.end[0], line.end[1]],
          exactEnd: exactPoint(line.end),
          start: rational(startNumerator, denominator),
          end: rational(endNumerator, denominator),
        });
        previousNumerator = endNumerator;
        previousDenominator = denominator;
      }
      if (previousNumerator !== previousDenominator) {
        return {
          ok: false,
          result: failure(
            'INVALID_PROVENANCE',
            `contour ${contourIndex} source segment ${segmentIndex} does not terminate at one`,
          ),
        };
      }
      prepared.push({
        cubic: segment.cubic,
        exactCubic: exactCubic(segment.cubic),
        lines: provenanceLines,
      });
    }
    preparedContours.push(prepared);
  }

  return { ok: true, limits: bounded, contours: preparedContours };
}

function validateSourceKinds(
  preflight: SuccessfulTopologyPreflight,
  sourceKinds: readonly boolean[],
): SourceKindsValidation {
  const supplied: unknown = sourceKinds;
  if (!isUnknownArray(supplied)) {
    return {
      ok: false,
      result: failure('INVALID_INPUT', 'source kinds must be an array'),
    };
  }

  const sourceCount = preflight.contours.reduce((sum, contour) => sum + contour.length, 0);
  if (supplied.length !== sourceCount) {
    return {
      ok: false,
      result: failure(
        'INVALID_INPUT',
        `source kinds length ${supplied.length} does not match ${sourceCount} source descriptors`,
      ),
    };
  }

  const flatKinds: boolean[] = [];
  for (let sourceIndex = 0; sourceIndex < sourceCount; sourceIndex += 1) {
    if (!hasIndex(supplied, sourceIndex)) {
      return {
        ok: false,
        result: failure('INVALID_INPUT', `source kinds entry ${sourceIndex} is missing`),
      };
    }
    const kind: unknown = supplied[sourceIndex];
    if (typeof kind !== 'boolean') {
      return {
        ok: false,
        result: failure(
          'INVALID_INPUT',
          `source kinds entry ${sourceIndex} must be a primitive boolean`,
        ),
      };
    }
    flatKinds.push(kind);
  }

  const kinds: boolean[][] = [];
  let sourceIndex = 0;
  for (let contourIndex = 0; contourIndex < preflight.contours.length; contourIndex += 1) {
    const contour = preflight.contours[contourIndex]!;
    const contourKinds: boolean[] = [];
    for (let segmentIndex = 0; segmentIndex < contour.length; segmentIndex += 1) {
      const kind = flatKinds[sourceIndex]!;
      contourKinds.push(kind);
      if (kind) {
        const segment = contour[segmentIndex]!;
        const controls = segment.exactCubic;
        const line = segment.lines[0];
        if (
          !equalPoint(controls[0], controls[1]) ||
          !equalPoint(controls[2], controls[3]) ||
          equalPoint(controls[0], controls[3]) ||
          segment.lines.length !== 1 ||
          line === undefined ||
          compare(line.start, ZERO) !== 0 ||
          compare(line.end, ONE) !== 0
        ) {
          return {
            ok: false,
            result: failure(
              'INVALID_INPUT',
              `contour ${contourIndex} source segment ${segmentIndex} has invalid marked LINE shape`,
            ),
          };
        }
      }
      sourceIndex += 1;
    }
    kinds.push(contourKinds);
  }

  return { ok: true, kinds };
}

function prepareRoundedTopologySuffix(
  preflight: SuccessfulTopologyPreflight,
  sourceKinds?: PreparedSourceKinds,
): RoundedTopologyPreparation {
  const bounded = preflight.limits;
  const preparedContours = preflight.contours;

  for (let contourIndex = 0; contourIndex < preparedContours.length; contourIndex += 1) {
    const contour = preparedContours[contourIndex]!;
    for (let segmentIndex = 0; segmentIndex < contour.length; segmentIndex += 1) {
      const segment = contour[segmentIndex]!;
      const finalActual = segment.lines[segment.lines.length - 1]!.exactEnd;
      if (!equalPoint(finalActual, segment.exactCubic[3])) {
        return {
          ok: false,
          result: failure(
            'KNOT_MISMATCH',
            `contour ${contourIndex} source segment ${segmentIndex} final endpoint differs from the exact source endpoint`,
          ),
        };
      }
    }
  }

  const leaves: RoundedLeaf[] = [];
  const contourLeafCounts: number[] = [];
  for (let contourIndex = 0; contourIndex < preparedContours.length; contourIndex += 1) {
    const contour = preparedContours[contourIndex]!;
    const firstOrdinary = contour[0]!.cubic[0];
    const firstExact = exactPoint(firstOrdinary);
    let ordinaryStart: Point = [firstOrdinary[0], firstOrdinary[1]];
    let actualStart = firstExact;
    let contourLeaf = 0;

    for (let segmentIndex = 0; segmentIndex < contour.length; segmentIndex += 1) {
      const segment = contour[segmentIndex]!;
      for (let lineIndex = 0; lineIndex < segment.lines.length; lineIndex += 1) {
        if (leaves.length >= bounded.maxLeaves) {
          return {
            ok: false,
            result: failure(
              'WORK_LIMIT',
              `topology exceeds ${bounded.maxLeaves} leaves`,
              leaves.length,
            ),
          };
        }
        const line = segment.lines[lineIndex]!;
        const controls = restrictCubic(segment.exactCubic, line.start, line.end);
        const sourceDifferences = sourceKinds?.[contourIndex]?.[segmentIndex]
          ? [pointSub(controls[3], controls[0])]
          : cubicDifferences(controls);
        leaves.push({
          contour: contourIndex,
          contourLeaf,
          hull: convexHull([...controls, actualStart, line.exactEnd]),
          start: actualStart,
          end: line.exactEnd,
          ordinaryStart: [ordinaryStart[0], ordinaryStart[1]],
          sourceStart: controls[0],
          sourceEnd: controls[3],
          sourceDifferences,
        });
        contourLeaf += 1;
        actualStart = line.exactEnd;
        ordinaryStart = line.ordinaryEnd;
      }
    }

    if (!equalPoint(actualStart, firstExact)) {
      if (leaves.length >= bounded.maxLeaves) {
        return {
          ok: false,
          result: failure(
            'WORK_LIMIT',
            `topology exceeds ${bounded.maxLeaves} leaves`,
            leaves.length,
          ),
        };
      }
      const difference = pointSub(firstExact, actualStart);
      leaves.push({
        contour: contourIndex,
        contourLeaf,
        hull: convexHull([actualStart, firstExact]),
        start: actualStart,
        end: firstExact,
        ordinaryStart: [ordinaryStart[0], ordinaryStart[1]],
        sourceStart: actualStart,
        sourceEnd: firstExact,
        sourceDifferences: [difference],
      });
      contourLeaf += 1;
    }
    contourLeafCounts.push(contourLeaf);
  }

  for (let contourIndex = 0; contourIndex < contourLeafCounts.length; contourIndex += 1) {
    if (contourLeafCounts[contourIndex]! < 3) {
      return {
        ok: false,
        result: failure(
          'UNRESOLVED',
          `contour ${contourIndex} has fewer than three leaves after closure`,
          leaves.length,
        ),
      };
    }
  }

  return { ok: true, limits: bounded, leaves, contourLeafCounts };
}

function prepareRoundedTopology(
  contours: readonly (readonly CubicTopologySegment[])[],
  limits: SimpleCubicTopologyLimits | undefined,
): RoundedTopologyPreparation {
  const preflight = prepareTopologyInput(contours, limits);
  if (!preflight.ok) return preflight;
  return prepareRoundedTopologySuffix(preflight);
}

function publishTopology(
  leaves: readonly LeafHull[],
  contourCount: number,
  pairs: number,
): SimpleCubicTopologyResult {
  const exactPolygons: ExactPoint[][] = Array.from({ length: contourCount }, () => []);
  const polygons: Point[][] = Array.from({ length: contourCount }, () => []);
  for (const leaf of leaves) {
    exactPolygons[leaf.contour]!.push(leaf.start);
    polygons[leaf.contour]!.push([leaf.ordinaryStart[0], leaf.ordinaryStart[1]]);
  }

  const orientations: (-1 | 1)[] = [];
  for (let contourIndex = 0; contourIndex < exactPolygons.length; contourIndex += 1) {
    const orientation = polygonOrientation(exactPolygons[contourIndex]!);
    if (orientation === 0) {
      return failure(
        'UNRESOLVED',
        `contour ${contourIndex} has zero exact polygon area`,
        leaves.length,
        pairs,
      );
    }
    orientations.push(orientation);
  }

  const winding: (-1 | 0 | 1)[][] = [];
  for (let queryIndex = 0; queryIndex < polygons.length; queryIndex += 1) {
    const row: (-1 | 0 | 1)[] = [];
    for (let containerIndex = 0; containerIndex < polygons.length; containerIndex += 1) {
      if (queryIndex === containerIndex) {
        row.push(0);
        continue;
      }
      const location = classifyLineFill(
        [polygons[containerIndex]!],
        polygons[queryIndex]![0]!,
        'evenodd',
      );
      if (location === 'boundary') {
        return failure(
          'UNRESOLVED',
          `contour ${queryIndex} initial knot is on contour ${containerIndex}'s polygon boundary`,
          leaves.length,
          pairs,
        );
      }
      row.push(location === 'inside' ? orientations[containerIndex]! : 0);
    }
    winding.push(row);
  }

  return success(leaves.length, pairs, { polygons, orientations, winding });
}

function publishTransverseArrangement(
  leaves: readonly RoundedLeaf[],
  contourCount: number,
  pairs: number,
  crossings: readonly TransverseArrangementCrossing[],
): TransverseArrangementResult {
  const polygons: Point[][] = Array.from({ length: contourCount }, () => []);
  for (const leaf of leaves) {
    polygons[leaf.contour]!.push([leaf.ordinaryStart[0], leaf.ordinaryStart[1]]);
  }
  return {
    ok: true,
    status: 'CERTIFIED',
    leaves: leaves.length,
    pairs,
    finding: null,
    certificate: {
      polygons,
      crossings: crossings.map((crossing) => ({
        leftLeaf: crossing.leftLeaf,
        rightLeaf: crossing.rightLeaf,
        orientation: crossing.orientation,
      })),
    },
  };
}

/**
 * Certifies the frozen P3.1e simple-cubic sufficient topology condition.
 * This test-only oracle intentionally uses exact rational work throughout.
 */
export function certifySimpleCubicTopology(
  contours: readonly (readonly CubicTopologySegment[])[],
  limits?: SimpleCubicTopologyLimits,
): SimpleCubicTopologyResult {
  const preflight = prepareTopologyInput(contours, limits);
  if (!preflight.ok) return preflight.result;
  const bounded = preflight.limits;
  const preparedContours = preflight.contours;

  const restrictedContours: RestrictedLeaf[][] = [];
  for (let contourIndex = 0; contourIndex < preparedContours.length; contourIndex += 1) {
    const contour = preparedContours[contourIndex]!;
    const restricted: RestrictedLeaf[] = [];
    for (let segmentIndex = 0; segmentIndex < contour.length; segmentIndex += 1) {
      const segment = contour[segmentIndex]!;
      let ordinaryStart: Point = [segment.cubic[0][0], segment.cubic[0][1]];
      let actualStart = exactPoint(ordinaryStart);
      for (let lineIndex = 0; lineIndex < segment.lines.length; lineIndex += 1) {
        const line = segment.lines[lineIndex]!;
        const controls = restrictCubic(segment.exactCubic, line.start, line.end);
        if (!equalPoint(actualStart, controls[0]) || !equalPoint(line.exactEnd, controls[3])) {
          return failure(
            'KNOT_MISMATCH',
            `contour ${contourIndex} source segment ${segmentIndex} line ${lineIndex} knot differs from the exact restriction`,
          );
        }
        restricted.push({
          controls,
          exactStart: actualStart,
          exactEnd: line.exactEnd,
          ordinaryStart: [ordinaryStart[0], ordinaryStart[1]],
          ordinaryEnd: [line.ordinaryEnd[0], line.ordinaryEnd[1]],
        });
        ordinaryStart = line.ordinaryEnd;
        actualStart = line.exactEnd;
      }
    }
    restrictedContours.push(restricted);
  }

  const leaves: LeafHull[] = [];
  const contourLeafCounts: number[] = [];
  for (let contourIndex = 0; contourIndex < restrictedContours.length; contourIndex += 1) {
    const sourceLeaves = restrictedContours[contourIndex]!;
    let contourLeaf = 0;
    for (let sourceLeaf = 0; sourceLeaf < sourceLeaves.length; sourceLeaf += 1) {
      const leaf = sourceLeaves[sourceLeaf]!;
      if (leaves.length >= bounded.maxLeaves) {
        return failure('WORK_LIMIT', `topology exceeds ${bounded.maxLeaves} leaves`, leaves.length);
      }
      if (!projectedMonotone(leaf.controls)) {
        return failure(
          'UNRESOLVED',
          `contour ${contourIndex} source leaf ${sourceLeaf} has a zero chord or nonmonotone projection`,
          leaves.length,
        );
      }
      leaves.push({
        contour: contourIndex,
        contourLeaf,
        hull: convexHull(leaf.controls),
        start: leaf.exactStart,
        end: leaf.exactEnd,
        ordinaryStart: [leaf.ordinaryStart[0], leaf.ordinaryStart[1]],
      });
      contourLeaf += 1;
    }

    const first = sourceLeaves[0]!;
    const last = sourceLeaves[sourceLeaves.length - 1]!;
    if (!equalPoint(last.exactEnd, first.exactStart)) {
      if (leaves.length >= bounded.maxLeaves) {
        return failure('WORK_LIMIT', `topology exceeds ${bounded.maxLeaves} leaves`, leaves.length);
      }
      leaves.push({
        contour: contourIndex,
        contourLeaf,
        hull: convexHull([last.exactEnd, first.exactStart]),
        start: last.exactEnd,
        end: first.exactStart,
        ordinaryStart: [last.ordinaryEnd[0], last.ordinaryEnd[1]],
      });
      contourLeaf += 1;
    }
    contourLeafCounts.push(contourLeaf);
  }

  for (let contourIndex = 0; contourIndex < contourLeafCounts.length; contourIndex += 1) {
    if (contourLeafCounts[contourIndex]! < 3) {
      return failure(
        'UNRESOLVED',
        `contour ${contourIndex} has fewer than three leaves after closure`,
        leaves.length,
      );
    }
  }

  let pairs = 0;
  for (let leftIndex = 0; leftIndex < leaves.length; leftIndex += 1) {
    const left = leaves[leftIndex]!;
    for (let rightIndex = leftIndex + 1; rightIndex < leaves.length; rightIndex += 1) {
      if (pairs >= bounded.maxPairs) {
        return failure(
          'WORK_LIMIT',
          `topology exceeds ${bounded.maxPairs} hull pairs`,
          leaves.length,
          pairs,
        );
      }
      const right = leaves[rightIndex]!;
      pairs += 1;
      const shared = adjacentSharedPoint(left, right, contourLeafCounts);
      if (shared) {
        if (!hullIntersectionIsOnly(left.hull, right.hull, shared)) {
          return failure(
            'UNRESOLVED',
            `adjacent hull pair ${leftIndex},${rightIndex} intersects beyond its shared knot`,
            leaves.length,
            pairs,
          );
        }
      } else if (closedHullsIntersect(left.hull, right.hull)) {
        return failure(
          'UNRESOLVED',
          `nonadjacent hull pair ${leftIndex},${rightIndex} intersects`,
          leaves.length,
          pairs,
        );
      }
    }
  }

  return publishTopology(leaves, restrictedContours.length, pairs);
}

/**
 * Certifies the frozen P3.1f sufficient condition for rounded internal knots.
 * Source-final endpoints remain exact; internal actual knots may be rounded.
 */
export function certifyRoundedKnotCubicTopology(
  contours: readonly (readonly CubicTopologySegment[])[],
  limits?: SimpleCubicTopologyLimits,
): SimpleCubicTopologyResult {
  const preparation = prepareRoundedTopology(contours, limits);
  if (!preparation.ok) return preparation.result;
  const bounded = preparation.limits;
  const leaves = preparation.leaves;
  const contourLeafCounts = preparation.contourLeafCounts;

  let pairs = 0;
  for (let leftIndex = 0; leftIndex < leaves.length; leftIndex += 1) {
    const left = leaves[leftIndex]!;
    for (let rightIndex = leftIndex + 1; rightIndex < leaves.length; rightIndex += 1) {
      if (pairs >= bounded.maxPairs) {
        return failure(
          'WORK_LIMIT',
          `topology exceeds ${bounded.maxPairs} hull pairs`,
          leaves.length,
          pairs,
        );
      }
      const right = leaves[rightIndex]!;
      pairs += 1;
      const adjacent = directedCyclicAdjacent(left, right, contourLeafCounts);
      if (adjacent) {
        const [previous, next] = adjacent;
        const direction = pointSub(next.sourceEnd, previous.sourceStart);
        if (
          !roundedLeafProgresses(previous, direction) ||
          !roundedLeafProgresses(next, direction)
        ) {
          return failure(
            'UNRESOLVED',
            `adjacent hull pair ${leftIndex},${rightIndex} lacks a common directed projection`,
            leaves.length,
            pairs,
          );
        }
      } else if (closedHullsIntersect(left.hull, right.hull)) {
        return failure(
          'UNRESOLVED',
          `nonadjacent hull pair ${leftIndex},${rightIndex} intersects`,
          leaves.length,
          pairs,
        );
      }
    }
  }

  return publishTopology(leaves, contourLeafCounts.length, pairs);
}

type TransverseArrangementPolicy = 'matching' | 'triangle-free';

/** Shares complete leaf append, pair-inspection, charge, and publication order. */
function certifyPreparedTransverseArrangement(
  preparation: Extract<RoundedTopologyPreparation, Readonly<{ ok: true }>>,
  policy: TransverseArrangementPolicy,
): TransverseArrangementResult {
  const bounded = preparation.limits;
  const leaves = preparation.leaves;
  const contourLeafCounts = preparation.contourLeafCounts;
  const partners: (number | null)[] | null =
    policy === 'matching' ? Array.from({ length: leaves.length }, () => null) : null;
  const crossings: TransverseArrangementCrossing[] = [];

  let pairs = 0;
  for (let leftIndex = 0; leftIndex < leaves.length; leftIndex += 1) {
    const left = leaves[leftIndex]!;
    for (let rightIndex = leftIndex + 1; rightIndex < leaves.length; rightIndex += 1) {
      if (pairs >= bounded.maxPairs) {
        return failure(
          'WORK_LIMIT',
          `topology exceeds ${bounded.maxPairs} hull pairs`,
          leaves.length,
          pairs,
        );
      }
      const right = leaves[rightIndex]!;
      pairs += 1;
      const adjacent = directedCyclicAdjacent(left, right, contourLeafCounts);
      if (adjacent) {
        const [previous, next] = adjacent;
        const direction = pointSub(next.sourceEnd, previous.sourceStart);
        if (
          !roundedLeafProgresses(previous, direction) ||
          !roundedLeafProgresses(next, direction)
        ) {
          return failure(
            'UNRESOLVED',
            `adjacent hull pair ${leftIndex},${rightIndex} lacks a common directed projection`,
            leaves.length,
            pairs,
          );
        }
        continue;
      }
      if (!closedHullsIntersect(left.hull, right.hull)) continue;

      const orientation = certifyTransverseRoundedPair(left, right);
      if (orientation === null) {
        return failure(
          'UNRESOLVED',
          `nonadjacent hull pair ${leftIndex},${rightIndex} intersects without a transverse certificate`,
          leaves.length,
          pairs,
        );
      }
      if (policy === 'matching') {
        if (partners![leftIndex] !== null) {
          return failure(
            'UNRESOLVED',
            `nonadjacent hull pair ${leftIndex},${rightIndex} has multiple transverse partners at leaf ${leftIndex}`,
            leaves.length,
            pairs,
          );
        }
        if (partners![rightIndex] !== null) {
          return failure(
            'UNRESOLVED',
            `nonadjacent hull pair ${leftIndex},${rightIndex} has multiple transverse partners at leaf ${rightIndex}`,
            leaves.length,
            pairs,
          );
        }
        partners![leftIndex] = rightIndex;
        partners![rightIndex] = leftIndex;
      } else {
        for (const leftCrossing of crossings) {
          let witness: number | null = null;
          if (leftCrossing.leftLeaf === leftIndex) witness = leftCrossing.rightLeaf;
          if (leftCrossing.rightLeaf === leftIndex) witness = leftCrossing.leftLeaf;
          if (witness === null) continue;
          const closesTriangle = crossings.some(
            (rightCrossing) =>
              (rightCrossing.leftLeaf === rightIndex && rightCrossing.rightLeaf === witness) ||
              (rightCrossing.rightLeaf === rightIndex && rightCrossing.leftLeaf === witness),
          );
          if (closesTriangle) {
            return failure(
              'UNRESOLVED',
              `nonadjacent hull pair ${leftIndex},${rightIndex} closes a crossing triangle`,
              leaves.length,
              pairs,
            );
          }
        }
        if (crossings.length >= 32) {
          return failure('WORK_LIMIT', `topology exceeds 32 crossings`, leaves.length, pairs);
        }
      }
      crossings.push({ leftLeaf: leftIndex, rightLeaf: rightIndex, orientation });
    }
  }

  return publishTransverseArrangement(leaves, contourLeafCounts.length, pairs, crossings);
}

/**
 * Certifies the frozen P3.1g test-only transverse arrangement condition.
 * Crossing records preserve complete leaf append and pair-inspection order.
 */
export function certifyTransverseCubicArrangement(
  contours: readonly (readonly CubicTopologySegment[])[],
  limits?: SimpleCubicTopologyLimits,
): TransverseArrangementResult {
  const preparation = prepareRoundedTopology(contours, limits);
  if (!preparation.ok) return preparation.result;
  return certifyPreparedTransverseArrangement(preparation, 'matching');
}

/**
 * Certifies the frozen P3.1h test-only mixed LINE/cubic transverse arrangement condition.
 * Source kinds are aligned to supplied descriptors in flat contour/source order.
 */
export function certifyMixedTransverseCubicArrangement(
  contours: readonly (readonly CubicTopologySegment[])[],
  sourceKinds: readonly boolean[],
  limits?: SimpleCubicTopologyLimits,
): TransverseArrangementResult {
  const preflight = prepareTopologyInput(contours, limits);
  if (!preflight.ok) return preflight.result;

  const validation = validateSourceKinds(preflight, sourceKinds);
  if (!validation.ok) return validation.result;

  const preparation = prepareRoundedTopologySuffix(preflight, validation.kinds);
  if (!preparation.ok) return preparation.result;
  return certifyPreparedTransverseArrangement(preparation, 'matching');
}

/**
 * Certifies the frozen P3.1i triangle-free mixed LINE/cubic arrangement condition.
 * Crossing records preserve complete leaf append and pair-inspection order.
 */
export function certifyTriangleFreeCubicArrangement(
  contours: readonly (readonly CubicTopologySegment[])[],
  sourceKinds: readonly boolean[],
  limits?: SimpleCubicTopologyLimits,
): TransverseArrangementResult {
  const preflight = prepareTopologyInput(contours, limits);
  if (!preflight.ok) return preflight.result;

  const validation = validateSourceKinds(preflight, sourceKinds);
  if (!validation.ok) return validation.result;

  const preparation = prepareRoundedTopologySuffix(preflight, validation.kinds);
  if (!preparation.ok) return preparation.result;
  return certifyPreparedTransverseArrangement(preparation, 'triangle-free');
}
