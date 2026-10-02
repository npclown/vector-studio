import type {
  Cubic,
  Matrix2,
  ReferenceFlattenedLine,
} from '../../../packages/geometry-reference/src/types.js';
import {
  absolute,
  add,
  compare,
  div,
  exactNumber,
  mul,
  rational,
  square,
  sub,
  ZERO,
  type Rational,
} from '../rounded-fill/exact.js';

export type CubicBoundaryStatus =
  | 'CERTIFIED'
  | 'INVALID_LIMITS'
  | 'INVALID_INPUT'
  | 'INVALID_PROVENANCE'
  | 'LOCAL_KNOT_ERROR'
  | 'PHYSICAL_ERROR'
  | 'UNRESOLVED'
  | 'WORK_LIMIT';

export type CubicBoundaryInput = Readonly<{
  cubic: Cubic;
  lines: readonly ReferenceFlattenedLine[];
  screen: Matrix2;
  sourceVerbOrdinal: number;
}>;

export type CubicBoundaryLimits = Readonly<{
  maxLines?: number;
  maxDepth?: number;
  maxCells?: number;
}>;

export type CubicBoundaryResult = Readonly<{
  ok: boolean;
  status: CubicBoundaryStatus;
  cells: number;
  finding: string | null;
  maxCertifiedSquared: Rational | null;
}>;

type ExactPoint = readonly [x: Rational, y: Rational];
type ExactMatrix = readonly [m00: Rational, m01: Rational, m10: Rational, m11: Rational];
type ExactLine = Readonly<{
  end: ExactPoint;
  numerator: bigint;
  denominator: bigint;
  depth: number;
}>;
type Cell = Readonly<{ left: Rational; right: Rational; depth: number }>;

const DEFAULT_MAX_LINES = 8192;
const DEFAULT_MAX_DEPTH = 24;
const DEFAULT_MAX_CELLS = 1_048_576;
const MAX_PROVENANCE_DEPTH = 20;
const MAX_U32 = 0xffff_ffff;
const UNIT = rational(1n, 1n << 1074n);
const ONE = rational(1n);
const SIX = rational(6n);
const EIGHT = rational(8n);
const TARGET_SQUARED = rational(1n, 64n);
const LOCAL_GUARD_SCALE = rational(1n, 1n << 45n);

export function decodeBoundaryNumber(value: number): Rational {
  if (!Number.isFinite(value)) throw new Error('boundary number must be finite');
  return mul(exactNumber(value), UNIT);
}

function failure(
  status: Exclude<CubicBoundaryStatus, 'CERTIFIED'>,
  finding: string,
  cells = 0,
): CubicBoundaryResult {
  return { ok: false, status, cells, finding, maxCertifiedSquared: null };
}

function success(cells: number, maxCertifiedSquared: Rational): CubicBoundaryResult {
  return { ok: true, status: 'CERTIFIED', cells, finding: null, maxCertifiedSquared };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteTuple(value: unknown, length: number): value is readonly number[] {
  if (!Array.isArray(value) || value.length !== length) return false;
  for (let index = 0; index < length; index += 1) {
    const component: unknown = value[index];
    if (typeof component !== 'number' || !Number.isFinite(component)) return false;
  }
  return true;
}

function isFiniteCubic(value: unknown): value is Cubic {
  if (!Array.isArray(value) || value.length !== 4) return false;
  for (let index = 0; index < 4; index += 1) {
    if (!isFiniteTuple(value[index], 2)) return false;
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

function readLimits(limits: unknown):
  | Readonly<{ ok: false; finding: string }>
  | Readonly<{
      ok: true;
      maxLines: number;
      maxDepth: number;
      maxCells: number;
    }> {
  if (limits !== undefined && !isRecord(limits)) {
    return { ok: false, finding: 'limits must be an object' };
  }
  const supplied = limits;
  const maxLines = supplied && 'maxLines' in supplied ? supplied.maxLines : DEFAULT_MAX_LINES;
  const maxDepth = supplied && 'maxDepth' in supplied ? supplied.maxDepth : DEFAULT_MAX_DEPTH;
  const maxCells = supplied && 'maxCells' in supplied ? supplied.maxCells : DEFAULT_MAX_CELLS;
  if (!validLimit(maxLines, 1, DEFAULT_MAX_LINES)) {
    return { ok: false, finding: 'maxLines must be a safe integer from 1 through 8192' };
  }
  if (!validLimit(maxDepth, 0, DEFAULT_MAX_DEPTH)) {
    return { ok: false, finding: 'maxDepth must be a safe integer from 0 through 24' };
  }
  if (!validLimit(maxCells, 1, DEFAULT_MAX_CELLS)) {
    return { ok: false, finding: 'maxCells must be a safe integer from 1 through 1048576' };
  }
  return { ok: true, maxLines, maxDepth, maxCells };
}

function maximum(values: readonly Rational[]): Rational {
  let result = values[0] ?? ZERO;
  for (let index = 1; index < values.length; index += 1) {
    const candidate = values[index]!;
    if (compare(candidate, result) > 0) result = candidate;
  }
  return result;
}

function pointDifference(a: ExactPoint, b: ExactPoint): ExactPoint {
  return [sub(a[0], b[0]), sub(a[1], b[1])];
}

function squaredNorm(point: ExactPoint): Rational {
  return add(square(point[0]), square(point[1]));
}

function transform(matrix: ExactMatrix, point: ExactPoint): ExactPoint {
  return [
    add(mul(matrix[0], point[0]), mul(matrix[1], point[1])),
    add(mul(matrix[2], point[0]), mul(matrix[3], point[1])),
  ];
}

function evaluateCubic(cubic: readonly ExactPoint[], t: Rational): ExactPoint {
  const oneMinusT = sub(ONE, t);
  const oneMinusTSquared = square(oneMinusT);
  const tSquared = square(t);
  const weights = [
    mul(oneMinusTSquared, oneMinusT),
    mul(rational(3n), mul(oneMinusTSquared, t)),
    mul(rational(3n), mul(oneMinusT, tSquared)),
    mul(tSquared, t),
  ] as const;
  return [
    add(
      add(mul(cubic[0]![0], weights[0]), mul(cubic[1]![0], weights[1])),
      add(mul(cubic[2]![0], weights[2]), mul(cubic[3]![0], weights[3])),
    ),
    add(
      add(mul(cubic[0]![1], weights[0]), mul(cubic[1]![1], weights[1])),
      add(mul(cubic[2]![1], weights[2]), mul(cubic[3]![1], weights[3])),
    ),
  ];
}

function evaluateSecondDerivative(cubic: readonly ExactPoint[], t: Rational): ExactPoint {
  const oneMinusT = sub(ONE, t);
  const component = (axis: 0 | 1): Rational => {
    const first = add(sub(cubic[2]![axis], mul(rational(2n), cubic[1]![axis])), cubic[0]![axis]);
    const second = add(sub(cubic[3]![axis], mul(rational(2n), cubic[2]![axis])), cubic[1]![axis]);
    return mul(SIX, add(mul(oneMinusT, first), mul(t, second)));
  };
  return [component(0), component(1)];
}

function lineAt(
  start: ExactPoint,
  end: ExactPoint,
  t0: Rational,
  t1: Rational,
  t: Rational,
): ExactPoint {
  const ratio = div(sub(t, t0), sub(t1, t0));
  return [
    add(start[0], mul(sub(end[0], start[0]), ratio)),
    add(start[1], mul(sub(end[1], start[1]), ratio)),
  ];
}

function errorAt(
  cubic: readonly ExactPoint[],
  matrix: ExactMatrix,
  start: ExactPoint,
  end: ExactPoint,
  t0: Rational,
  t1: Rational,
  t: Rational,
): ExactPoint {
  return transform(matrix, pointDifference(evaluateCubic(cubic, t), lineAt(start, end, t0, t1, t)));
}

function localGuard(cubic: readonly ExactPoint[], depth: number): Rational {
  const p0 = cubic[0]!;
  const original = maximum([
    ONE,
    ...cubic.flatMap((point) => [absolute(point[0]), absolute(point[1])]),
  ]);
  const relative = maximum(
    cubic.flatMap((point) => [absolute(sub(point[0], p0[0])), absolute(sub(point[1], p0[1]))]),
  );
  return mul(LOCAL_GUARD_SCALE, add(original, mul(rational(BigInt(depth + 1)), relative)));
}

export function certifyCubicBoundary(
  input: CubicBoundaryInput,
  limits?: CubicBoundaryLimits,
): CubicBoundaryResult {
  const checkedLimits = readLimits(limits);
  if (!checkedLimits.ok) return failure('INVALID_LIMITS', checkedLimits.finding);

  const runtimeInput: unknown = input;
  if (!isRecord(runtimeInput) || !Array.isArray(runtimeInput.lines)) {
    return failure('INVALID_INPUT', 'input must contain a lines array');
  }
  if (input.lines.length === 0) {
    return failure('INVALID_INPUT', 'cubic must emit at least one line');
  }
  if (input.lines.length > checkedLimits.maxLines) {
    return failure('WORK_LIMIT', `cubic emits more than ${checkedLimits.maxLines} lines`);
  }

  if (!isFiniteCubic(input.cubic)) {
    return failure('INVALID_INPUT', 'cubic must contain four finite point tuples');
  }
  if (!isFiniteTuple(input.screen, 4)) {
    return failure('INVALID_INPUT', 'screen must be a finite four-component matrix');
  }
  if (
    typeof input.sourceVerbOrdinal !== 'number' ||
    !Number.isSafeInteger(input.sourceVerbOrdinal) ||
    input.sourceVerbOrdinal < 0 ||
    input.sourceVerbOrdinal > MAX_U32
  ) {
    return failure('INVALID_INPUT', 'sourceVerbOrdinal must be a u32 integer');
  }
  for (let index = 0; index < input.lines.length; index += 1) {
    const candidate: unknown = input.lines[index];
    if (!isRecord(candidate) || !isFiniteTuple(candidate.end, 2)) {
      return failure('INVALID_INPUT', `line ${index} must contain a finite endpoint tuple`);
    }
  }

  const exactLines: ExactLine[] = [];
  let previousNumerator = 0n;
  let previousDenominator = 1n;
  for (let index = 0; index < input.lines.length; index += 1) {
    const line = input.lines[index]!;
    const candidate: unknown = line.provenance;
    if (!isRecord(candidate)) {
      return failure('INVALID_PROVENANCE', `line ${index} must contain provenance`);
    }
    const source = candidate.sourceVerbOrdinal;
    const numerator = candidate.endNumerator;
    const depth = candidate.depth;
    if (source !== input.sourceVerbOrdinal) {
      return failure('INVALID_PROVENANCE', `line ${index} has the wrong source verb ordinal`);
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
      return failure('INVALID_PROVENANCE', `line ${index} has invalid dyadic provenance`);
    }
    const denominator = 1n << BigInt(depth);
    const startNumerator = BigInt(numerator - 1);
    if (previousNumerator * denominator !== startNumerator * previousDenominator) {
      return failure('INVALID_PROVENANCE', `line ${index} provenance is not adjacent`);
    }
    exactLines.push({
      end: [decodeBoundaryNumber(line.end[0]), decodeBoundaryNumber(line.end[1])],
      numerator: BigInt(numerator),
      denominator,
      depth,
    });
    previousNumerator = BigInt(numerator);
    previousDenominator = denominator;
  }
  if (previousNumerator !== previousDenominator) {
    return failure('INVALID_PROVENANCE', 'cubic provenance does not terminate at one');
  }

  const exactCubic: readonly ExactPoint[] = input.cubic.map(
    (point) => [decodeBoundaryNumber(point[0]), decodeBoundaryNumber(point[1])] as const,
  );
  const exactMatrix = input.screen.map(decodeBoundaryNumber) as unknown as ExactMatrix;

  let previousPoint = exactCubic[0]!;
  let previousDepth = 0;
  for (let index = 0; index < exactLines.length; index += 1) {
    const line = exactLines[index]!;
    const t0 = rational(line.numerator - 1n, line.denominator);
    const t1 = rational(line.numerator, line.denominator);
    if (index > 0) {
      const startDistance = squaredNorm(
        pointDifference(previousPoint, evaluateCubic(exactCubic, t0)),
      );
      const startGuard = localGuard(exactCubic, previousDepth);
      if (compare(startDistance, square(startGuard)) > 0) {
        return failure('LOCAL_KNOT_ERROR', `line ${index} start exceeds its local guard`);
      }
    }
    const endDistance = squaredNorm(pointDifference(line.end, evaluateCubic(exactCubic, t1)));
    const endGuard = localGuard(exactCubic, line.depth);
    if (compare(endDistance, square(endGuard)) > 0) {
      return failure('LOCAL_KNOT_ERROR', `line ${index} endpoint exceeds its local guard`);
    }
    previousPoint = line.end;
    previousDepth = line.depth;
  }

  let cells = 0;
  let maxCertifiedSquared = ZERO;
  previousPoint = exactCubic[0]!;
  for (let lineIndex = 0; lineIndex < exactLines.length; lineIndex += 1) {
    const line = exactLines[lineIndex]!;
    const t0 = rational(line.numerator - 1n, line.denominator);
    const t1 = rational(line.numerator, line.denominator);
    const stack: Cell[] = [{ left: t0, right: t1, depth: line.depth }];
    while (stack.length > 0) {
      if (cells >= checkedLimits.maxCells) {
        return failure(
          'WORK_LIMIT',
          `continuous verification exceeds ${checkedLimits.maxCells} cells`,
          cells,
        );
      }
      const cell = stack.pop()!;
      cells += 1;
      const leftError = errorAt(
        exactCubic,
        exactMatrix,
        previousPoint,
        line.end,
        t0,
        t1,
        cell.left,
      );
      const rightError = errorAt(
        exactCubic,
        exactMatrix,
        previousPoint,
        line.end,
        t0,
        t1,
        cell.right,
      );
      if (
        compare(squaredNorm(leftError), TARGET_SQUARED) > 0 ||
        compare(squaredNorm(rightError), TARGET_SQUARED) > 0
      ) {
        return failure(
          'PHYSICAL_ERROR',
          `line ${lineIndex} has an endpoint witness above 1/8 pixel`,
          cells,
        );
      }

      const leftSecond = transform(exactMatrix, evaluateSecondDerivative(exactCubic, cell.left));
      const rightSecond = transform(exactMatrix, evaluateSecondDerivative(exactCubic, cell.right));
      const hSquaredOverEight = div(square(sub(cell.right, cell.left)), EIGHT);
      const upperX = add(
        maximum([absolute(leftError[0]), absolute(rightError[0])]),
        mul(maximum([absolute(leftSecond[0]), absolute(rightSecond[0])]), hSquaredOverEight),
      );
      const upperY = add(
        maximum([absolute(leftError[1]), absolute(rightError[1])]),
        mul(maximum([absolute(leftSecond[1]), absolute(rightSecond[1])]), hSquaredOverEight),
      );
      const upperSquared = add(square(upperX), square(upperY));
      if (compare(upperSquared, TARGET_SQUARED) <= 0) {
        if (compare(upperSquared, maxCertifiedSquared) > 0) maxCertifiedSquared = upperSquared;
        continue;
      }
      if (cell.depth >= checkedLimits.maxDepth) {
        return failure(
          'UNRESOLVED',
          `line ${lineIndex} is unresolved at depth ${cell.depth}`,
          cells,
        );
      }
      const middle = div(add(cell.left, cell.right), rational(2n));
      stack.push(
        { left: middle, right: cell.right, depth: cell.depth + 1 },
        { left: cell.left, right: middle, depth: cell.depth + 1 },
      );
    }
    previousPoint = line.end;
  }
  return success(cells, maxCertifiedSquared);
}
