import type { Bounds, BoundsValidationResult, Cubic, Point } from './types.js';

const ROOT_WIDTH = 2 ** -48;
const MAX_BISECTIONS = 64;
const EPSILON = 2 ** -52;

function finite(value: number, label: string): number {
  if (!Number.isFinite(value)) {
    throw new RangeError(`${label} is not finite`);
  }
  return value;
}

function coordinate(point: Point, axis: 0 | 1): number {
  return point[axis];
}

function evaluateScalarBernstein(
  p0: number,
  p1: number,
  p2: number,
  p3: number,
  t: number,
): number {
  const u = 1 - t;
  return finite(
    u * u * u * p0 + 3 * u * u * t * p1 + 3 * u * t * t * p2 + t * t * t * p3,
    'cubic evaluation',
  );
}

function evaluateQuadraticBernstein(d0: number, d1: number, d2: number, t: number): number {
  const u = 1 - t;
  return finite(u * u * d0 + 2 * u * t * d1 + t * t * d2, 'derivative evaluation');
}

function derivativeRoots(p0: number, p1: number, p2: number, p3: number): readonly number[] {
  const d0 = finite(3 * (p1 - p0), 'derivative control');
  const d1 = finite(3 * (p2 - p1), 'derivative control');
  const d2 = finite(3 * (p3 - p2), 'derivative control');
  if (d0 === 0 && d1 === 0 && d2 === 0) {
    return [];
  }

  const curvature = finite(d0 - 2 * d1 + d2, 'derivative curvature');
  const slope = finite(2 * (d1 - d0), 'derivative slope');
  const vertex = curvature === 0 ? undefined : -slope / (2 * curvature);
  const partitions = [0];
  if (vertex !== undefined && Number.isFinite(vertex) && vertex > 0 && vertex < 1) {
    partitions.push(vertex);
  }
  partitions.push(1);

  const candidates: number[] = [];
  const add = (t: number): void => {
    if (t > 0 && t < 1 && !candidates.includes(t)) {
      candidates.push(t);
    }
  };

  if (vertex !== undefined && vertex > 0 && vertex < 1) {
    // A zero-touch root has no sign change. Retaining the derivative vertex
    // catches it independently; for a non-root monotone curve this interior
    // value remains between endpoint extrema and cannot enlarge the bounds.
    evaluateQuadraticBernstein(d0, d1, d2, vertex);
    add(vertex);
  }

  for (let index = 0; index + 1 < partitions.length; index += 1) {
    let left = partitions[index]!;
    let right = partitions[index + 1]!;
    let leftValue = evaluateQuadraticBernstein(d0, d1, d2, left);
    const rightValue = evaluateQuadraticBernstein(d0, d1, d2, right);
    if (leftValue === 0) add(left);
    if (rightValue === 0) add(right);
    if (leftValue === 0 || rightValue === 0 || Math.sign(leftValue) === Math.sign(rightValue)) {
      continue;
    }

    let converged = false;
    for (let iteration = 0; iteration < MAX_BISECTIONS; iteration += 1) {
      if (right - left <= ROOT_WIDTH) {
        converged = true;
        break;
      }
      const middle = left + (right - left) / 2;
      const middleValue = evaluateQuadraticBernstein(d0, d1, d2, middle);
      if (middleValue === 0) {
        left = middle;
        right = middle;
        converged = true;
        break;
      }
      if (Math.sign(middleValue) === Math.sign(leftValue)) {
        left = middle;
        leftValue = middleValue;
      } else {
        right = middle;
      }
    }
    if (!converged && right - left > ROOT_WIDTH) {
      throw new RangeError('derivative root did not converge');
    }
    add(left);
    add(right);
  }
  return candidates.sort((left, right) => left - right);
}

export function evaluateCubic(cubic: Cubic, t: number): Point {
  if (!Number.isFinite(t)) throw new RangeError('parameter is not finite');
  return [
    evaluateScalarBernstein(cubic[0][0], cubic[1][0], cubic[2][0], cubic[3][0], t),
    evaluateScalarBernstein(cubic[0][1], cubic[1][1], cubic[2][1], cubic[3][1], t),
  ];
}

export function evaluateCubicDerivative(cubic: Cubic, t: number): Point {
  const x = [
    finite(3 * (cubic[1][0] - cubic[0][0]), 'x derivative control'),
    finite(3 * (cubic[2][0] - cubic[1][0]), 'x derivative control'),
    finite(3 * (cubic[3][0] - cubic[2][0]), 'x derivative control'),
  ] as const;
  const y = [
    finite(3 * (cubic[1][1] - cubic[0][1]), 'y derivative control'),
    finite(3 * (cubic[2][1] - cubic[1][1]), 'y derivative control'),
    finite(3 * (cubic[3][1] - cubic[2][1]), 'y derivative control'),
  ] as const;
  return [
    evaluateQuadraticBernstein(x[0], x[1], x[2], t),
    evaluateQuadraticBernstein(y[0], y[1], y[2], t),
  ];
}

export function evaluateCubicSecondDerivative(cubic: Cubic, t: number): Point {
  const u = 1 - t;
  return [
    finite(
      6 *
        (u * (cubic[2][0] - 2 * cubic[1][0] + cubic[0][0]) +
          t * (cubic[3][0] - 2 * cubic[2][0] + cubic[1][0])),
      'x second derivative',
    ),
    finite(
      6 *
        (u * (cubic[2][1] - 2 * cubic[1][1] + cubic[0][1]) +
          t * (cubic[3][1] - 2 * cubic[2][1] + cubic[1][1])),
      'y second derivative',
    ),
  ];
}

export function referenceCubicBounds(cubic: Cubic): Bounds {
  for (const point of cubic) {
    finite(point[0], 'x control');
    finite(point[1], 'y control');
  }
  const xRoots = derivativeRoots(
    coordinate(cubic[0], 0),
    coordinate(cubic[1], 0),
    coordinate(cubic[2], 0),
    coordinate(cubic[3], 0),
  );
  const yRoots = derivativeRoots(
    coordinate(cubic[0], 1),
    coordinate(cubic[1], 1),
    coordinate(cubic[2], 1),
    coordinate(cubic[3], 1),
  );
  const xs = [cubic[0][0], cubic[3][0]];
  const ys = [cubic[0][1], cubic[3][1]];
  for (const root of xRoots) xs.push(evaluateCubic(cubic, root)[0]);
  for (const root of yRoots) ys.push(evaluateCubic(cubic, root)[1]);
  return {
    minX: Math.min(...xs),
    minY: Math.min(...ys),
    maxX: Math.max(...xs),
    maxY: Math.max(...ys),
  };
}

export function referenceBoundsTolerance(cubic: Cubic): number {
  let magnitude = 1;
  for (const point of cubic) {
    magnitude = Math.max(magnitude, Math.abs(point[0]), Math.abs(point[1]));
  }
  return 1e-9 + 256 * EPSILON * magnitude;
}

export function validateReferenceBounds(cubic: Cubic, candidate: Bounds): BoundsValidationResult {
  const findings: string[] = [];
  let expected: Bounds;
  let tolerance: number;
  try {
    expected = referenceCubicBounds(cubic);
    tolerance = referenceBoundsTolerance(cubic);
  } catch (error) {
    findings.push(error instanceof Error ? error.message : 'independent bounds evaluation failed');
    return { ok: false, findings, expected: null, tolerance: null };
  }
  if (![candidate.minX, candidate.minY, candidate.maxX, candidate.maxY].every(Number.isFinite)) {
    findings.push('candidate bounds must be finite');
  }
  if (candidate.minX > candidate.maxX || candidate.minY > candidate.maxY) {
    findings.push('candidate bounds are inverted');
  }
  const components = [
    ['minX', candidate.minX, expected.minX, true],
    ['minY', candidate.minY, expected.minY, true],
    ['maxX', candidate.maxX, expected.maxX, false],
    ['maxY', candidate.maxY, expected.maxY, false],
  ] as const;
  for (const [name, actual, reference, minimum] of components) {
    const contains = minimum ? actual <= reference + tolerance : actual >= reference - tolerance;
    if (!contains) findings.push(`${name} understates the independent bound`);
    const tight = minimum
      ? actual >= reference - 2 * tolerance
      : actual <= reference + 2 * tolerance;
    if (!tight) findings.push(`${name} is not tight within the independent tolerance`);
  }
  return { ok: findings.length === 0, findings, expected, tolerance };
}
