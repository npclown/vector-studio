import { referenceCubicBounds } from './cubic.js';
import {
  REFERENCE_PATH_STATUS,
  REFERENCE_VERB,
  type Bounds,
  type CanonicalPackedInput,
  type CanonicalValidationResult,
  type Cubic,
  type ReferencePathBoundsResult,
  type ReferenceRequest,
} from './types.js';

const ZERO_BOUNDS: Bounds = Object.freeze({ minX: 0, minY: 0, maxX: 0, maxY: 0 });
const U32_MAX = 0xffff_ffff;

function isU32(value: number): boolean {
  return Number.isInteger(value) && value >= 0 && value <= U32_MAX;
}

function validateOffsets(
  values: ArrayLike<number>,
  expectedCount: number,
  terminal: number,
  name: string,
): string[] {
  const findings: string[] = [];
  if (values.length !== expectedCount + 1)
    findings.push(`${name} must contain pathCount+1 entries`);
  if (values.length === 0 || values[0] !== 0) findings.push(`${name} must start at zero`);
  let previous = 0;
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === undefined || !isU32(value)) {
      findings.push(`${name}[${index}] must be u32`);
      continue;
    }
    if (value < previous) findings.push(`${name} must be nondecreasing`);
    previous = value;
  }
  if (values.length > 0 && values[values.length - 1] !== terminal) {
    findings.push(`${name} terminal must equal its buffer length`);
  }
  return findings;
}

function tokenFindings(request: ReferenceRequest, index: number): string[] {
  const findings: string[] = [];
  if (!isU32(request.requestId)) findings.push(`requests[${index}].requestId must be u32`);
  if (!isU32(request.sourceEpoch)) findings.push(`requests[${index}].sourceEpoch must be u32`);
  if (!isU32(request.sourceRevision))
    findings.push(`requests[${index}].sourceRevision must be u32`);
  return findings;
}

function pathResult(
  request: ReferenceRequest,
  status: ReferencePathBoundsResult['status'],
  bounds: Bounds,
  findings: readonly string[],
): ReferencePathBoundsResult {
  return {
    requestId: request.requestId,
    sourceEpoch: request.sourceEpoch,
    sourceRevision: request.sourceRevision,
    status,
    bounds,
    findings,
  };
}

function unionBounds(target: Bounds | undefined, addition: Bounds): Bounds {
  if (target === undefined) return addition;
  return {
    minX: Math.min(target.minX, addition.minX),
    minY: Math.min(target.minY, addition.minY),
    maxX: Math.max(target.maxX, addition.maxX),
    maxY: Math.max(target.maxY, addition.maxY),
  };
}

function pointBounds(x: number, y: number): Bounds {
  return { minX: x, minY: y, maxX: x, maxY: y };
}

function inspectPath(
  input: CanonicalPackedInput,
  pathIndex: number,
  request: ReferenceRequest,
): ReferencePathBoundsResult {
  const verbStart = input.pathOffsets[pathIndex]!;
  const verbEnd = input.pathOffsets[pathIndex + 1]!;
  const pointStart = input.pointOffsets[pathIndex]!;
  const pointEnd = input.pointOffsets[pathIndex + 1]!;
  let pointIndex = pointStart;
  let current: readonly [number, number] | undefined;
  let subpathStart: readonly [number, number] | undefined;
  let open = false;
  let bounds: Bounds | undefined;
  const cubics: Cubic[] = [];
  const invalid = (finding: string) =>
    pathResult(request, REFERENCE_PATH_STATUS.INVALID_PATH, ZERO_BOUNDS, [finding]);
  const readPoint = (): readonly [number, number] | undefined => {
    if (pointIndex + 2 > pointEnd) return undefined;
    const x = input.points[pointIndex];
    const y = input.points[pointIndex + 1];
    pointIndex += 2;
    return x === undefined || y === undefined ? undefined : [x, y];
  };

  for (let verbIndex = verbStart; verbIndex < verbEnd; verbIndex += 1) {
    const verb = input.verbs[verbIndex];
    if (verb === REFERENCE_VERB.MOVE) {
      const point = readPoint();
      if (point === undefined) return invalid('MOVE point arity exceeds point range');
      if (!point.every(Number.isFinite)) return invalid('path coordinate must be finite');
      current = point;
      subpathStart = point;
      open = true;
      bounds = unionBounds(bounds, pointBounds(point[0], point[1]));
    } else if (verb === REFERENCE_VERB.LINE) {
      if (!open || current === undefined) return invalid('LINE requires an open subpath');
      const point = readPoint();
      if (point === undefined) return invalid('LINE point arity exceeds point range');
      if (!point.every(Number.isFinite)) return invalid('path coordinate must be finite');
      current = point;
      bounds = unionBounds(bounds, pointBounds(point[0], point[1]));
    } else if (verb === REFERENCE_VERB.CUBIC) {
      if (!open || current === undefined) return invalid('CUBIC requires an open subpath');
      const control1 = readPoint();
      const control2 = readPoint();
      const end = readPoint();
      if (control1 === undefined || control2 === undefined || end === undefined) {
        return invalid('CUBIC point arity exceeds point range');
      }
      if (![...control1, ...control2, ...end].every(Number.isFinite)) {
        return invalid('path coordinate must be finite');
      }
      cubics.push([current, control1, control2, end]);
      current = end;
    } else if (verb === REFERENCE_VERB.CLOSE) {
      if (!open || current === undefined || subpathStart === undefined) {
        return invalid('CLOSE requires an open subpath');
      }
      current = subpathStart;
      open = false;
    } else {
      return invalid(`unknown verb ${String(verb)}`);
    }
  }
  if (pointIndex !== pointEnd) return invalid('path point range has unconsumed scalars');
  if (!Number.isFinite(request.bucketTolerance) || request.bucketTolerance <= 0) {
    return pathResult(request, REFERENCE_PATH_STATUS.INVALID_TOLERANCE, ZERO_BOUNDS, [
      'bucket tolerance must be finite and positive',
    ]);
  }
  try {
    for (const cubic of cubics) bounds = unionBounds(bounds, referenceCubicBounds(cubic));
  } catch (error) {
    return pathResult(request, REFERENCE_PATH_STATUS.NUMERIC_RANGE, ZERO_BOUNDS, [
      error instanceof Error ? error.message : 'cubic bounds failed',
    ]);
  }
  if (bounds === undefined)
    return pathResult(request, REFERENCE_PATH_STATUS.EMPTY, ZERO_BOUNDS, []);
  return pathResult(request, REFERENCE_PATH_STATUS.OK, bounds, []);
}

export function validateCanonicalPackedInput(
  input: CanonicalPackedInput,
): CanonicalValidationResult {
  const pathCount = input.requests.length;
  const findings = [
    ...validateOffsets(input.pathOffsets, pathCount, input.verbs.length, 'pathOffsets'),
    ...validateOffsets(input.pointOffsets, pathCount, input.points.length, 'pointOffsets'),
  ];
  for (let index = 0; index < input.requests.length; index += 1) {
    findings.push(...tokenFindings(input.requests[index]!, index));
  }
  if (input.verbs.length > U32_MAX || input.points.length > U32_MAX) {
    findings.push('packed input lengths must fit u32');
  }
  if (findings.length > 0) return { ok: false, findings };
  return {
    ok: true,
    paths: input.requests.map((request, index) => inspectPath(input, index, request)),
  };
}

export const referencePackedPathBounds = validateCanonicalPackedInput;
