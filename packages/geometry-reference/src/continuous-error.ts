import { evaluateCubic, evaluateCubicSecondDerivative } from './cubic.js';
import { matrixSigmaMax } from './tolerance.js';
import type {
  ContinuousErrorResult,
  Cubic,
  Matrix2,
  Point,
  ReferenceFlattenedLine,
} from './types.js';

const EPSILON = 2 ** -52;
const TARGET = 0.25;
const MAX_VERIFICATION_DEPTH = 24;
const MAX_CELLS = 1_048_576;
const MAX_LINES = 8192;

function transform(matrix: Matrix2, point: Point): Point {
  return [matrix[0] * point[0] + matrix[1] * point[1], matrix[2] * point[0] + matrix[3] * point[1]];
}

function norm(point: Point): number {
  return Math.hypot(point[0], point[1]);
}

function numericGuard(cubic: Cubic, depth: number): number {
  let original = 1;
  let relative = 0;
  for (const point of cubic) {
    original = Math.max(original, Math.abs(point[0]), Math.abs(point[1]));
    relative = Math.max(
      relative,
      Math.abs(point[0] - cubic[0][0]),
      Math.abs(point[1] - cubic[0][1]),
    );
  }
  return 128 * EPSILON * (original + (depth + 1) * relative);
}

function makeResult(
  findings: readonly string[],
  cells: number,
  maxEvaluatedError: number,
  maxCertifiedUpperBound: number,
): ContinuousErrorResult {
  return { ok: findings.length === 0, findings, cells, maxEvaluatedError, maxCertifiedUpperBound };
}

export function validateContinuousCubicError(
  cubic: Cubic,
  lines: readonly ReferenceFlattenedLine[],
  screen: Matrix2,
  sourceVerbOrdinal = 0,
): ContinuousErrorResult {
  const findings: string[] = [];
  if (lines.length === 0) findings.push('cubic must emit at least one line');
  if (lines.length > MAX_LINES) findings.push('cubic emits more than 8192 lines');
  if (!screen.every(Number.isFinite)) findings.push('screen matrix must be finite');
  if (!cubic.flat().every(Number.isFinite)) findings.push('cubic controls must be finite');
  const sigma = matrixSigmaMax(screen);
  if (!Number.isFinite(sigma)) findings.push('screen singular value must be finite');

  let previousNumerator = 0;
  let previousDepth = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    const { provenance } = line;
    if (!line.end.every(Number.isFinite)) findings.push(`line ${index} endpoint must be finite`);
    if (provenance.sourceVerbOrdinal !== sourceVerbOrdinal) {
      findings.push(`line ${index} has the wrong source verb ordinal`);
    }
    if (
      !Number.isInteger(provenance.depth) ||
      provenance.depth < 0 ||
      provenance.depth > 20 ||
      !Number.isInteger(provenance.endNumerator) ||
      provenance.endNumerator <= 0 ||
      provenance.endNumerator > 2 ** provenance.depth
    ) {
      findings.push(`line ${index} has invalid dyadic provenance`);
      continue;
    }
    const expectedPrevious = provenance.endNumerator - 1;
    const commonDepth = Math.max(previousDepth, provenance.depth);
    const previousAtCommon = previousNumerator * 2 ** (commonDepth - previousDepth);
    const expectedAtCommon = expectedPrevious * 2 ** (commonDepth - provenance.depth);
    if (previousAtCommon !== expectedAtCommon) {
      findings.push(`line ${index} provenance has a gap or overlap`);
    }
    previousNumerator = provenance.endNumerator;
    previousDepth = provenance.depth;
  }
  if (lines.length > 0 && previousNumerator !== 2 ** previousDepth) {
    findings.push('cubic provenance does not end at one');
  }
  if (findings.length > 0) return makeResult(findings, 0, 0, 0);

  let cells = 0;
  let maxEvaluatedError = 0;
  let maxCertifiedUpperBound = 0;
  let previousPoint = cubic[0];
  try {
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index]!;
      const { provenance } = line;
      const t0 = (provenance.endNumerator - 1) / 2 ** provenance.depth;
      const t1 = provenance.endNumerator / 2 ** provenance.depth;
      const expectedStart = evaluateCubic(cubic, t0);
      const expectedEnd = evaluateCubic(cubic, t1);
      const localStartError = norm([
        expectedStart[0] - previousPoint[0],
        expectedStart[1] - previousPoint[1],
      ]);
      const localEndError = norm([expectedEnd[0] - line.end[0], expectedEnd[1] - line.end[1]]);
      const startError = norm(
        transform(screen, [
          expectedStart[0] - previousPoint[0],
          expectedStart[1] - previousPoint[1],
        ]),
      );
      const endError = norm(
        transform(screen, [expectedEnd[0] - line.end[0], expectedEnd[1] - line.end[1]]),
      );
      const localGuard = numericGuard(cubic, provenance.depth);
      const physicalGuard = sigma * localGuard;
      maxEvaluatedError = Math.max(maxEvaluatedError, startError, endError);
      if (!Number.isFinite(localGuard) || !Number.isFinite(physicalGuard)) {
        findings.push('declared numerical guard is not finite');
        return makeResult(findings, cells, maxEvaluatedError, maxCertifiedUpperBound);
      }
      if (localStartError > localGuard || localEndError > localGuard) {
        findings.push(`line ${index} endpoint exceeds the local declared numerical guard`);
        return makeResult(findings, cells, maxEvaluatedError, maxCertifiedUpperBound);
      }

      type Cell = Readonly<{ left: number; right: number; depth: number }>;
      const stack: Cell[] = [{ left: t0, right: t1, depth: provenance.depth }];
      const lineAt = (t: number): Point => {
        const ratio = (t - t0) / (t1 - t0);
        return [
          previousPoint[0] + (line.end[0] - previousPoint[0]) * ratio,
          previousPoint[1] + (line.end[1] - previousPoint[1]) * ratio,
        ];
      };
      const errorAt = (t: number): number => {
        const curve = evaluateCubic(cubic, t);
        const returned = lineAt(t);
        return norm(transform(screen, [curve[0] - returned[0], curve[1] - returned[1]]));
      };

      while (stack.length > 0) {
        if (cells >= MAX_CELLS) {
          findings.push('continuous verification exceeded its cell limit');
          return makeResult(findings, cells, maxEvaluatedError, maxCertifiedUpperBound);
        }
        const cell = stack.pop()!;
        cells += 1;
        const leftError = errorAt(cell.left);
        const rightError = errorAt(cell.right);
        maxEvaluatedError = Math.max(maxEvaluatedError, leftError, rightError);
        if (!Number.isFinite(leftError) || !Number.isFinite(rightError)) {
          findings.push('continuous verification produced a nonfinite error');
          return makeResult(findings, cells, maxEvaluatedError, maxCertifiedUpperBound);
        }
        if (leftError > TARGET || rightError > TARGET) {
          findings.push(`line ${index} exceeds the physical error target`);
          return makeResult(findings, cells, maxEvaluatedError, maxCertifiedUpperBound);
        }
        const secondLeft = norm(transform(screen, evaluateCubicSecondDerivative(cubic, cell.left)));
        const secondRight = norm(
          transform(screen, evaluateCubicSecondDerivative(cubic, cell.right)),
        );
        const width = cell.right - cell.left;
        const upper =
          Math.max(leftError, rightError) +
          (Math.max(secondLeft, secondRight) * width * width) / 8 +
          physicalGuard;
        if (!Number.isFinite(upper)) {
          findings.push('continuous verification produced a nonfinite upper bound');
          return makeResult(findings, cells, maxEvaluatedError, maxCertifiedUpperBound);
        }
        if (upper <= TARGET) {
          maxCertifiedUpperBound = Math.max(maxCertifiedUpperBound, upper);
          continue;
        }
        if (cell.depth >= MAX_VERIFICATION_DEPTH) {
          findings.push(`line ${index} continuous error remained unresolved at depth 24`);
          return makeResult(findings, cells, maxEvaluatedError, maxCertifiedUpperBound);
        }
        const middle = cell.left + width / 2;
        stack.push(
          { left: middle, right: cell.right, depth: cell.depth + 1 },
          { left: cell.left, right: middle, depth: cell.depth + 1 },
        );
      }
      previousPoint = line.end;
    }
  } catch (error) {
    findings.push(error instanceof Error ? error.message : 'continuous verification failed');
  }
  return makeResult(findings, cells, maxEvaluatedError, maxCertifiedUpperBound);
}
