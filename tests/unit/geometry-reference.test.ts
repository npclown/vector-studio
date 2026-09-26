import { describe, expect, it } from 'vitest';
import {
  CONTINUOUS_ERROR_POSITIVE_CONTROLS,
  METAMORPHIC_CUBIC_FIXTURES,
  NAMED_CUBIC_FIXTURES,
  NAMED_PACKED_FIXTURES,
  P2_CORPUS_VERSION,
  REFERENCE_PATH_STATUS,
  SUBDIVISION_METAMORPHIC_FIXTURE,
  evaluateCubic,
  evaluateCubicDerivative,
  generateP2GeometryCorpus,
  referenceBoundsTolerance,
  referenceCubicBounds,
  screenTolerance,
  validateCanonicalPackedInput,
  validateContinuousCubicError,
  validateReferenceBounds,
  type Cubic,
  type Matrix2,
  type ReferenceFlattenedLine,
} from '../../packages/geometry-reference/src/index.js';

const IDENTITY: Matrix2 = [1, 0, 0, 1];

function uniformLeaves(
  cubic: Cubic,
  depth: number,
  sourceVerbOrdinal = 0,
): ReferenceFlattenedLine[] {
  return Array.from({ length: 2 ** depth }, (_, index) => ({
    end: evaluateCubic(cubic, (index + 1) / 2 ** depth),
    provenance: { sourceVerbOrdinal, endNumerator: index + 1, depth },
  }));
}

describe('independent cubic reference', () => {
  it('finds analytic extrema, including a double derivative root', () => {
    const arch: Cubic = [
      [0, 0],
      [1, 1],
      [2, 1],
      [3, 0],
    ];
    expect(referenceCubicBounds(arch)).toEqual({ minX: 0, minY: 0, maxX: 3, maxY: 0.75 });
    const doubleRoot = NAMED_CUBIC_FIXTURES.find((fixture) => fixture.name === 'double-root')!;
    expect(referenceCubicBounds(doubleRoot.cubic)).toEqual({ minX: 0, minY: 0, maxX: 3, maxY: 1 });
  });

  it('rejects understated and excessively loose candidate bounds', () => {
    const cubic: Cubic = [
      [0, 0],
      [1, 2],
      [2, 2],
      [3, 0],
    ];
    const expected = referenceCubicBounds(cubic);
    expect(validateReferenceBounds(cubic, expected).ok).toBe(true);
    expect(
      validateReferenceBounds(cubic, { ...expected, maxY: expected.maxY - 0.01 }).findings,
    ).toContain('maxY understates the independent bound');
    expect(validateReferenceBounds(cubic, { ...expected, minX: -1 }).findings).toContain(
      'minX is not tight within the independent tolerance',
    );
  });

  it('reports nonfinite source bounds as failed verification', () => {
    const invalid: Cubic = [
      [0, 0],
      [Number.NaN, 1],
      [2, 2],
      [3, 3],
    ];
    const observed = validateReferenceBounds(invalid, { minX: 0, minY: 0, maxX: 3, maxY: 3 });
    expect(observed).toMatchObject({ ok: false, expected: null, tolerance: null });
    expect(observed.findings.length).toBeGreaterThan(0);
  });

  it('contains the same geometry under reversal, translation, scaling, and midpoint subdivision', () => {
    for (const fixture of METAMORPHIC_CUBIC_FIXTURES) {
      const source = referenceCubicBounds(fixture.source);
      const transformed = referenceCubicBounds(fixture.transformed);
      if (fixture.transform === 'reverse') expect(transformed).toEqual(source);
      if (fixture.transform === 'translate') {
        const tolerance = referenceBoundsTolerance(fixture.transformed);
        expect(Math.abs(transformed.minX - (source.minX + 1e6))).toBeLessThanOrEqual(tolerance);
        expect(Math.abs(transformed.minY - (source.minY - 1e6))).toBeLessThanOrEqual(tolerance);
        expect(Math.abs(transformed.maxX - (source.maxX + 1e6))).toBeLessThanOrEqual(tolerance);
        expect(Math.abs(transformed.maxY - (source.maxY - 1e6))).toBeLessThanOrEqual(tolerance);
      }
      if (fixture.transform === 'uniform-scale') {
        const tolerance = referenceBoundsTolerance(fixture.transformed);
        expect(Math.abs(transformed.minX - source.minX * 8)).toBeLessThanOrEqual(tolerance);
        expect(Math.abs(transformed.minY - source.minY * 8)).toBeLessThanOrEqual(tolerance);
        expect(Math.abs(transformed.maxX - source.maxX * 8)).toBeLessThanOrEqual(tolerance);
        expect(Math.abs(transformed.maxY - source.maxY * 8)).toBeLessThanOrEqual(tolerance);
      }
    }
    const whole = referenceCubicBounds(SUBDIVISION_METAMORPHIC_FIXTURE.source);
    const halves = SUBDIVISION_METAMORPHIC_FIXTURE.halves.map(referenceCubicBounds);
    expect({
      minX: Math.min(...halves.map((value) => value.minX)),
      minY: Math.min(...halves.map((value) => value.minY)),
      maxX: Math.max(...halves.map((value) => value.maxX)),
      maxY: Math.max(...halves.map((value) => value.maxY)),
    }).toEqual(whole);
  });

  it('uses a genuine interior cusp fixture', () => {
    const cusp = NAMED_CUBIC_FIXTURES.find((fixture) => fixture.name === 'cusp')!;
    const derivative = evaluateCubicDerivative(cusp.cubic, 0.5);
    expect(derivative[0]).toBeCloseTo(0, 14);
    expect(derivative[1]).toBeCloseTo(0, 14);
  });

  it('executes every named cubic through independent bounds and continuous certification', () => {
    for (const fixture of NAMED_CUBIC_FIXTURES) {
      if (fixture.expectation === 'numeric-range') {
        expect(() => referenceCubicBounds(fixture.cubic), fixture.name).toThrow(RangeError);
        continue;
      }
      expect(
        Object.values(referenceCubicBounds(fixture.cubic)).every(Number.isFinite),
        fixture.name,
      ).toBe(true);
      const observed = validateContinuousCubicError(
        fixture.cubic,
        uniformLeaves(fixture.cubic, 10),
        IDENTITY,
      );
      expect(observed.ok, `${fixture.name}: ${observed.findings.join('; ')}`).toBe(true);
    }
  });
});

describe('canonical packed path reference', () => {
  it('executes every named packed fixture with envelope/path separation', () => {
    for (const fixture of NAMED_PACKED_FIXTURES) {
      const observed = validateCanonicalPackedInput(fixture.input);
      expect(observed.ok, fixture.name).toBe(fixture.envelopeValid);
      if (observed.ok && fixture.statuses !== undefined) {
        expect(
          observed.paths.map((path) => path.status),
          fixture.name,
        ).toEqual(fixture.statuses);
      }
    }
  });

  it('keeps an invalid path atomic and evaluates a later valid path', () => {
    const fixture = NAMED_PACKED_FIXTURES.find((value) => value.name === 'mixed-failed-success')!;
    const observed = validateCanonicalPackedInput(fixture.input);
    expect(observed.ok).toBe(true);
    if (!observed.ok) return;
    expect(observed.paths[0]).toMatchObject({
      status: REFERENCE_PATH_STATUS.INVALID_PATH,
      bounds: { minX: 0, minY: 0, maxX: 0, maxY: 0 },
    });
    expect(observed.paths[1]).toMatchObject({
      status: REFERENCE_PATH_STATUS.OK,
      bounds: { minX: 2, minY: 2, maxX: 2, maxY: 2 },
    });
  });
});

describe('screen tolerance and continuous physical error', () => {
  it('computes stable singular values and downward power-of-two buckets', () => {
    expect(screenTolerance(IDENTITY, 1, 1)).toMatchObject({
      ok: true,
      sigmaMax: 1,
      bucketTolerance: 0.25,
    });
    expect(screenTolerance([0, -1, 1, 0], 1, 1)).toMatchObject({
      ok: true,
      sigmaMax: 1,
      bucketTolerance: 0.25,
    });
    expect(screenTolerance([1, 3, 0, 1], 64, 3)).toMatchObject({
      ok: true,
      bucketTolerance: 2 ** -12,
    });
    expect(screenTolerance([0, 0, 0, 0], 1, 1)).toMatchObject({
      ok: true,
      sigmaMax: 0,
      bucketTolerance: 1,
    });
    expect(screenTolerance(IDENTITY, 0, 1)).toMatchObject({
      ok: false,
      status: 'INVALID_TOLERANCE',
    });
  });

  it('certifies continuous error and resets dyadic provenance for adjacent cubics', () => {
    const first: Cubic = [
      [0, 0],
      [1, 0],
      [2, 0],
      [3, 0],
    ];
    const second: Cubic = [
      [3, 0],
      [4, 1],
      [5, 1],
      [6, 0],
    ];
    const firstResult = validateContinuousCubicError(
      first,
      uniformLeaves(first, 0, 4),
      IDENTITY,
      4,
    );
    const secondResult = validateContinuousCubicError(
      second,
      uniformLeaves(second, 3, 5),
      IDENTITY,
      5,
    );
    expect(firstResult.ok).toBe(true);
    expect(secondResult.ok).toBe(true);
    expect(secondResult.maxCertifiedUpperBound).toBeLessThanOrEqual(0.25);
  });

  it('rejects each endpoint/provenance positive control', () => {
    for (const fixture of CONTINUOUS_ERROR_POSITIVE_CONTROLS) {
      const observed = validateContinuousCubicError(fixture.cubic, fixture.lines, IDENTITY, 2);
      expect(observed.ok, fixture.name).toBe(false);
      expect(observed.findings.join(' '), fixture.name).toContain(fixture.expectedFinding);
    }
  });

  it('rejects endpoint corruption hidden by zero and rank-one screen matrices', () => {
    const line: Cubic = [
      [0, 0],
      [1, 0],
      [2, 0],
      [3, 0],
    ];
    const corrupted: ReferenceFlattenedLine[] = [
      { end: [3, 1], provenance: { sourceVerbOrdinal: 0, endNumerator: 1, depth: 0 } },
    ];
    expect(validateContinuousCubicError(line, corrupted, [0, 0, 0, 0]).ok).toBe(false);
    expect(validateContinuousCubicError(line, corrupted, [1, 0, 0, 0]).ok).toBe(false);
  });
});

describe('frozen deterministic corpus', () => {
  it('generates 10,000 reproducible scheduled cubics with finite independent bounds', () => {
    const first = generateP2GeometryCorpus();
    const second = generateP2GeometryCorpus();
    expect(first).toHaveLength(10_000);
    expect(first[0]).toEqual(second[0]);
    expect(first[9_999]).toEqual(second[9_999]);
    expect(first[0]).toMatchObject({
      version: P2_CORPUS_VERSION,
      index: 0,
      seed: 1,
      localTransform: 'identity',
    });
    expect(first[1]).toMatchObject({ index: 1, localTransform: 'translate(1e9,-1e9)' });
    for (const fixture of first) {
      expect(
        Object.values(referenceCubicBounds(fixture.cubic)).every(Number.isFinite),
        String(fixture.index),
      ).toBe(true);
      expect(fixture.bucketTolerance).toBeGreaterThan(0);
    }
  });
});
