import type { Matrix2, ScreenToleranceResult } from './types.js';

const TARGET_PHYSICAL_PIXELS = 0.25;

function downwardPowerOfTwo(value: number): number {
  // log2 can round a finite value just below MAX_VALUE up to 1024.
  let bucket = 2 ** Math.min(1023, Math.floor(Math.log2(value)));
  if (bucket > value) bucket /= 2;
  while (Number.isFinite(bucket * 2) && bucket * 2 <= value) bucket *= 2;
  return bucket;
}

export function matrixSigmaMax(matrix: Matrix2): number {
  const scale = Math.max(...matrix.map((value) => Math.abs(value)));
  if (!Number.isFinite(scale)) return Number.NaN;
  if (scale === 0) return 0;
  const a = matrix[0] / scale;
  const b = matrix[1] / scale;
  const c = matrix[2] / scale;
  const d = matrix[3] / scale;
  const xx = a * a + c * c;
  const yy = b * b + d * d;
  const xy = a * b + c * d;
  const lambda = (xx + yy + Math.hypot(xx - yy, 2 * xy)) / 2;
  return scale * Math.sqrt(Math.max(0, lambda));
}

export function screenTolerance(world: Matrix2, zoom: number, dpr: number): ScreenToleranceResult {
  if (!Number.isFinite(zoom) || !Number.isFinite(dpr) || zoom <= 0 || dpr <= 0) {
    return {
      ok: false,
      status: 'INVALID_TOLERANCE',
      finding: 'zoom and DPR must be finite and positive',
    };
  }
  if (!world.every(Number.isFinite)) {
    return { ok: false, status: 'NUMERIC_RANGE', finding: 'world matrix must be finite' };
  }
  const factor = zoom * dpr;
  if (!Number.isFinite(factor) || factor <= 0) {
    return {
      ok: false,
      status: 'NUMERIC_RANGE',
      finding: 'zoom and DPR product is unrepresentable',
    };
  }
  const screen = world.map((value) => value * factor) as unknown as Matrix2;
  if (!screen.every(Number.isFinite)) {
    return { ok: false, status: 'NUMERIC_RANGE', finding: 'screen matrix overflowed' };
  }
  if (world.some((value) => value !== 0) && screen.every((value) => value === 0)) {
    return { ok: false, status: 'NUMERIC_RANGE', finding: 'screen matrix underflowed to zero' };
  }
  const sigmaMax = matrixSigmaMax(screen);
  if (!Number.isFinite(sigmaMax)) {
    return { ok: false, status: 'NUMERIC_RANGE', finding: 'singular value is not finite' };
  }
  if (sigmaMax === 0) {
    return { ok: true, screen, sigmaMax, bucketTolerance: 1 };
  }
  const required = TARGET_PHYSICAL_PIXELS / sigmaMax;
  if (!Number.isFinite(required) || required <= 0) {
    return { ok: false, status: 'NUMERIC_RANGE', finding: 'local tolerance is unrepresentable' };
  }
  const bucketTolerance = downwardPowerOfTwo(required);
  if (!Number.isFinite(bucketTolerance) || bucketTolerance <= 0 || bucketTolerance > required) {
    return { ok: false, status: 'NUMERIC_RANGE', finding: 'tolerance bucket is unrepresentable' };
  }
  return { ok: true, screen, sigmaMax, bucketTolerance };
}
