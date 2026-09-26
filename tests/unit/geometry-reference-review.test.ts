import { describe, expect, it } from 'vitest';
import { validateContinuousCubicError } from '../../packages/geometry-reference/src/continuous-error.js';
import {
  referenceCubicBounds,
  validateReferenceBounds,
} from '../../packages/geometry-reference/src/cubic.js';
import { generateP2GeometryCorpus } from '../../packages/geometry-reference/src/corpus.js';
import { referencePackedPathBounds } from '../../packages/geometry-reference/src/packed-reference.js';
import { screenTolerance } from '../../packages/geometry-reference/src/tolerance.js';
import type {
  CanonicalPackedInput,
  Cubic,
  ReferenceFlattenedLine,
} from '../../packages/geometry-reference/src/types.js';

const identity = [1, 0, 0, 1] as const;
const line: Cubic = [
  [0, 0],
  [1, 0],
  [2, 0],
  [3, 0],
];
const leaf = (x: number, y: number): readonly ReferenceFlattenedLine[] => [
  { end: [x, y], provenance: { sourceVerbOrdinal: 0, endNumerator: 1, depth: 0 } },
];

function overflowPath(verbs: number[], tolerance: number): CanonicalPackedInput {
  return {
    requests: [{ requestId: 19, sourceEpoch: 2, sourceRevision: 3, bucketTolerance: tolerance }],
    pathOffsets: [0, verbs.length],
    pointOffsets: [0, 8],
    verbs,
    points: [1e308, 0, -1e308, 0, 1e308, 0, -1e308, 0],
  };
}

describe('Primary independent P2 oracle review', () => {
  it('uses the frozen seed values and independent world/zoom/DPR schedules', () => {
    const corpus = generateP2GeometryCorpus();
    expect(corpus).toHaveLength(10_000);
    expect(corpus[0]?.cubic.flat()).toEqual([
      -999.8740996234119, -968.5051436536014, 232.80820483341813, -856.762730050832,
      116.97671608999372, -652.8516039252281, -705.4992793127894, -797.0852022990584,
    ]);
    expect(corpus[5]?.world).toEqual([4, 0, 0, 0.25]);
    expect(corpus[25]?.zoom).toBe(1);
    expect(corpus[75]?.dpr).toBe(2);
    expect(corpus[2500]).toMatchObject({ seed: 0x12345678, seedIndex: 0, index: 2500, zoom: 1 });
    expect(screenTolerance([1, 3, 0, 1], 1, 2)).toMatchObject({
      ok: true,
      bucketTolerance: 1 / 32,
    });
  });

  it('enforces complete path validation and tolerance precedence before numerical work', () => {
    const malformed = referencePackedPathBounds(overflowPath([0, 2, 255], -1));
    const tolerance = referencePackedPathBounds(overflowPath([0, 2], -1));
    expect(malformed.ok).toBe(true);
    expect(tolerance.ok).toBe(true);
    if (!malformed.ok || !tolerance.ok) throw new Error('valid batch envelopes rejected');
    expect(malformed.paths[0]?.status).toBe(2);
    expect(tolerance.paths[0]?.status).toBe(3);
    expect(malformed.paths[0]).toMatchObject({ requestId: 19, sourceEpoch: 2, sourceRevision: 3 });
  });

  it('rejects a shifted endpoint even when its physical error remains below a quarter pixel', () => {
    expect(validateContinuousCubicError(line, leaf(3, 0.01), identity).ok).toBe(false);
    expect(validateContinuousCubicError(line, leaf(3, 100), [1, 0, 0, 0]).ok).toBe(false);
    expect(validateContinuousCubicError(line, leaf(300, 100), [0, 0, 0, 0]).ok).toBe(false);
  });

  it('reports malformed/nonfinite numeric evidence as failed verification', () => {
    const invalid: Cubic = [
      [0, 0],
      [Number.NaN, 0],
      [2, 0],
      [3, 0],
    ];
    expect(validateContinuousCubicError(invalid, leaf(3, 0), identity).ok).toBe(false);
    expect(validateContinuousCubicError(line, leaf(Number.NaN, 0), identity).ok).toBe(false);
  });

  it('certifies refined intervals without reporting a rejected coarse bound as certified', () => {
    const curve: Cubic = [
      [0, 0],
      [1, 0.3],
      [2, -0.3],
      [3, 0],
    ];
    const result = validateContinuousCubicError(curve, leaf(3, 0), identity);
    expect(result.ok).toBe(true);
    expect(result.cells).toBeGreaterThan(1);
    expect(result.maxCertifiedUpperBound).toBeLessThanOrEqual(0.25);
  });

  it('does not reinterpret arithmetic underflow as an intentionally collapsed world transform', () => {
    expect(screenTolerance(identity, Number.MIN_VALUE, Number.MIN_VALUE)).toMatchObject({
      ok: false,
      status: 'NUMERIC_RANGE',
    });
    expect(
      screenTolerance([Number.MIN_VALUE, 0, 0, Number.MIN_VALUE], Number.MIN_VALUE, 1),
    ).toMatchObject({
      ok: false,
      status: 'NUMERIC_RANGE',
    });
    expect(screenTolerance([0, 0, 0, 0], 1, 1)).toMatchObject({
      ok: true,
      sigmaMax: 0,
      bucketTolerance: 1,
    });
  });

  it('selects the largest finite power of two when log2 rounds a finite tolerance to 1024', () => {
    const scale = 0.25 / Number.MAX_VALUE + Number.MIN_VALUE;
    expect(Number.isFinite(0.25 / scale)).toBe(true);
    expect(Math.log2(0.25 / scale)).toBe(1024);
    expect(screenTolerance([scale, 0, 0, scale], 1, 1)).toMatchObject({
      ok: true,
      bucketTolerance: 2 ** 1023,
    });
  });

  it('finds the analytic arch extremum and preserves translated bounds', () => {
    const arch: Cubic = [
      [0, 0],
      [1, 1],
      [2, 1],
      [3, 0],
    ];
    expect(referenceCubicBounds(arch)).toEqual({ minX: 0, minY: 0, maxX: 3, maxY: 0.75 });
    const translated = arch.map(([x, y]) => [x + 1e9, y - 1e9]) as unknown as Cubic;
    const bounds = referenceCubicBounds(translated);
    expect(bounds.minX).toBe(1e9);
    expect(bounds.maxX).toBe(1e9 + 3);
    expect(bounds.minY).toBe(-1e9);
    expect(bounds.maxY).toBeCloseTo(-1e9 + 0.75, 5);
    expect(validateReferenceBounds(arch, { minX: 0, minY: 0, maxX: 3, maxY: 0.7 }).ok).toBe(false);
    expect(validateReferenceBounds(arch, { minX: -1, minY: 0, maxX: 3, maxY: 0.75 }).ok).toBe(
      false,
    );
    const nonfinite: Cubic = [
      [0, 0],
      [Number.NaN, 1],
      [2, 1],
      [3, 0],
    ];
    expect(validateReferenceBounds(nonfinite, bounds).ok).toBe(false);
  });
});
