import { describe, expect, it } from 'vitest';
import type { ReferenceFlattenedLine } from '../../packages/geometry-reference/src/types.js';
import { certifyCubicBoundary } from '../geometry/cubic-boundary/oracle.js';
import {
  fixedMixedLineArrangementControl,
  fixedMixedLineArrangementFixtures,
  fixedMixedLineNContours,
} from '../geometry/mixed-line-arrangement/fixtures.js';
import { fixedNativeTransverseArrangementFixtureRows } from '../geometry/native-transverse-arrangement/fixtures.js';
import {
  certifyMixedTransverseCubicArrangement,
  certifyTransverseCubicArrangement,
  type CubicTopologySegment,
  type SimpleCubicTopologyLimits,
  type TransverseArrangementResult,
} from '../geometry/simple-cubic-topology/oracle.js';
import { bitsOf } from '../geometry/rounded-fill/exact.js';

type Contours = readonly (readonly CubicTopologySegment[])[];

const fixtures = fixedMixedLineArrangementFixtures();

function totalSources(contours: Contours): number {
  return contours.reduce((sum, contour) => sum + contour.length, 0);
}

function allFalse(contours: Contours): readonly boolean[] {
  return Array.from({ length: totalSources(contours) }, () => false);
}

function polygonBits(polygons: readonly (readonly (readonly [number, number])[])[]): string {
  return JSON.stringify(
    polygons.map((polygon) =>
      polygon.map(([x, y]) => [bitsOf(x).toString(16), bitsOf(y).toString(16)]),
    ),
  );
}

function expectFailure(
  contours: Contours,
  sourceKinds: readonly boolean[],
  status: TransverseArrangementResult['status'],
  finding: string,
  limits?: SimpleCubicTopologyLimits,
): TransverseArrangementResult {
  const result = certifyMixedTransverseCubicArrangement(contours, sourceKinds, limits);
  expect(result.status).toBe(status);
  expect(result.ok).toBe(false);
  expect(result.leaves).toBe(0);
  expect(result.pairs).toBe(0);
  expect(result.finding).toContain(finding);
  expect(result.certificate).toBeNull();
  return result;
}

function replaceSegment(
  contours: Contours,
  contourIndex: number,
  segmentIndex: number,
  replacement: CubicTopologySegment,
): Contours {
  return contours.map((contour, candidateContour) =>
    candidateContour === contourIndex
      ? contour.map((segment, candidateSegment) =>
          candidateSegment === segmentIndex ? replacement : segment,
        )
      : contour,
  );
}

function shiftOrdinal(segment: CubicTopologySegment, amount: number): CubicTopologySegment {
  const sourceVerbOrdinal = segment.sourceVerbOrdinal + amount;
  return {
    ...segment,
    sourceVerbOrdinal,
    lines: segment.lines.map((line) => ({
      ...line,
      provenance: { ...line.provenance, sourceVerbOrdinal },
    })),
  };
}

function deepFreeze(value: unknown): void {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
}

describe('P3.1h explicit LINE-kind arrangement positives', () => {
  it('freezes the exact seven-fixture inventory, literal metadata, and source identities', () => {
    expect(fixtures.map(({ id }) => id)).toEqual([
      'line-cubic',
      'line-line',
      'line-closure',
      'reflected',
      'packed-ordinals',
      'two-closures',
      'marked-signed-zero',
    ]);
    expect(fixtures.map(({ expected }) => [expected.leaves, expected.pairs])).toEqual([
      [8, 28],
      [8, 28],
      [8, 28],
      [8, 28],
      [8, 28],
      [16, 120],
      [8, 28],
    ]);
    expect(fixtures.map(({ allFalse }) => [allFalse.leaves, allFalse.pairs])).toEqual([
      [8, 4],
      [8, 4],
      [8, 22],
      [8, 4],
      [8, 4],
      [16, 46],
      [8, 4],
    ]);
    expect(fixtures[4]!.contours[0]!.map(({ sourceVerbOrdinal }) => sourceVerbOrdinal)).toEqual([
      2, 3, 4, 5, 6, 7, 8, 9,
    ]);
    const twoClosures = fixtures[5]!;
    expect(
      twoClosures.contours.map((contour) =>
        contour.map(({ sourceVerbOrdinal }) => sourceVerbOrdinal),
      ),
    ).toEqual([
      [1, 2, 3, 4, 5, 6, 7],
      [9, 10, 11, 12, 13, 14, 15],
    ]);
    expect(twoClosures.sourceKinds.flatMap((kind, index) => (kind ? [index] : []))).toEqual([
      3, 10,
    ]);
    expect(twoClosures.expected.crossings).toEqual([
      { leftLeaf: 3, rightLeaf: 7, orientation: 1 },
      { leftLeaf: 11, rightLeaf: 15, orientation: 1 },
    ]);
  });

  it.each(fixtures)('$id certifies literal polygons and ordered crossings', (fixture) => {
    const result = certifyMixedTransverseCubicArrangement(fixture.contours, fixture.sourceKinds);
    expect(result).toEqual({
      ok: true,
      status: 'CERTIFIED',
      leaves: fixture.expected.leaves,
      pairs: fixture.expected.pairs,
      finding: null,
      certificate: {
        polygons: fixture.expected.polygons,
        crossings: fixture.expected.crossings,
      },
    });
  });

  it('preserves signed-zero polygon bits without fabricating an extra closure', () => {
    const fixture = fixtures[6]!;
    const first = fixture.contours[0]![0]!;
    const last = fixture.contours[0]!.at(-1)!;
    expect(Object.is(first.cubic[0][0], -0)).toBe(true);
    expect(Object.is(first.cubic[0][1], -0)).toBe(true);
    expect(Object.is(first.cubic[1][0], +0)).toBe(true);
    expect(Object.is(first.cubic[1][1], +0)).toBe(true);
    expect(Object.is(last.cubic[3][0], +0)).toBe(true);
    expect(Object.is(last.cubic[3][1], +0)).toBe(true);
    const result = certifyMixedTransverseCubicArrangement(fixture.contours, fixture.sourceKinds);
    expect(result.leaves).toBe(8);
    const actual = result.certificate!.polygons[0]![0]!;
    expect(bitsOf(actual[0])).toBe(bitsOf(-0));
    expect(bitsOf(actual[1])).toBe(bitsOf(-0));
  });

  it('retains independent P3.1d positional proofs for every unmarked source', () => {
    for (const fixture of fixtures) {
      let flatIndex = 0;
      for (const contour of fixture.contours) {
        for (const segment of contour) {
          if (!fixture.sourceKinds[flatIndex]) {
            const result = certifyCubicBoundary({
              cubic: segment.cubic,
              lines: segment.lines,
              screen: [1, 0, 0, 1],
              sourceVerbOrdinal: segment.sourceVerbOrdinal,
            });
            expect(result.status, `${fixture.id} source ${flatIndex}`).toBe('CERTIFIED');
          }
          flatIndex += 1;
        }
      }
      expect(flatIndex).toBe(fixture.sourceKinds.length);
    }
  });

  it('keeps old and mixed entries identical and unresolved when every kind is false', () => {
    for (const fixture of fixtures) {
      const kinds = allFalse(fixture.contours);
      const oldResult = certifyTransverseCubicArrangement(fixture.contours);
      const mixedResult = certifyMixedTransverseCubicArrangement(fixture.contours, kinds);
      expect(mixedResult, fixture.id).toEqual(oldResult);
      expect(mixedResult.status, fixture.id).toBe('UNRESOLVED');
      expect([mixedResult.leaves, mixedResult.pairs], fixture.id).toEqual([
        fixture.allFalse.leaves,
        fixture.allFalse.pairs,
      ]);
    }
  });

  it('preserves all 39 native arrangement rows exactly with all-false kinds', () => {
    const rows = fixedNativeTransverseArrangementFixtureRows();
    const statuses = { CERTIFIED: 0, KNOT_MISMATCH: 0, UNRESOLVED: 0 };
    expect(rows).toHaveLength(39);
    for (const row of rows) {
      const oldResult = certifyTransverseCubicArrangement(row.contours);
      const mixedResult = certifyMixedTransverseCubicArrangement(
        row.contours,
        allFalse(row.contours),
      );
      expect(mixedResult, row.id).toEqual(oldResult);
      if (
        mixedResult.status === 'CERTIFIED' ||
        mixedResult.status === 'KNOT_MISMATCH' ||
        mixedResult.status === 'UNRESOLVED'
      )
        statuses[mixedResult.status] += 1;
    }
    expect(statuses).toEqual({ CERTIFIED: 24, KNOT_MISMATCH: 2, UNRESOLVED: 13 });
  });
});

describe('P3.1h kinds validation, precedence, and geometric rejection', () => {
  it('rejects non-array, short, long, sparse, and nonboolean sidecars structurally', () => {
    const fixture = fixtures[0]!;
    const sparse = new Array<boolean>(8);
    for (let index = 0; index < sparse.length; index += 1) if (index !== 3) sparse[index] = false;
    const invalid = [
      null,
      fixture.sourceKinds.slice(0, -1),
      [...fixture.sourceKinds, false],
      sparse,
      fixture.sourceKinds.map((kind, index) => (index === 3 ? 1 : kind)),
    ];
    for (const sourceKinds of invalid)
      expectFailure(
        fixture.contours,
        sourceKinds as unknown as readonly boolean[],
        'INVALID_INPUT',
        'source kinds',
      );
  });

  it('rejects marked nonlinear, zero, and valid two-leaf descriptors as LINE shape failures', () => {
    const fixture = fixtures[0]!;
    const markedNonlinear = fixture.sourceKinds.map((kind, index) => kind || index === 4);
    expectFailure(fixture.contours, markedNonlinear, 'INVALID_INPUT', 'marked LINE');

    const n = fixedMixedLineNContours()[0]!;
    const start = n[0]!.cubic[0];
    const zero: CubicTopologySegment = {
      cubic: [start, start, start, start],
      sourceVerbOrdinal: 1,
      lines: [
        {
          end: start,
          provenance: { sourceVerbOrdinal: 1, endNumerator: 1, depth: 0 },
        },
      ],
    };
    const shifted = n.map((segment) => shiftOrdinal(segment, 1));
    expectFailure(
      [[zero, ...shifted]],
      [true, ...allFalse([shifted])],
      'INVALID_INPUT',
      'marked LINE',
    );

    const first = fixture.contours[0]![0]!;
    const split: CubicTopologySegment = {
      ...first,
      lines: [
        {
          end: [0, 0],
          provenance: { sourceVerbOrdinal: 1, endNumerator: 1, depth: 1 },
        },
        {
          end: first.cubic[3],
          provenance: { sourceVerbOrdinal: 1, endNumerator: 2, depth: 1 },
        },
      ],
    };
    expectFailure(
      replaceSegment(fixture.contours, 0, 0, split),
      fixture.sourceKinds,
      'INVALID_INPUT',
      'marked LINE',
    );
  });

  it('preserves global validation precedence before source-final checks', () => {
    const fixture = fixtures[0]!;
    const first = fixture.contours[0]![0]!;
    const mismatch: CubicTopologySegment = {
      ...first,
      lines: [{ ...first.lines[0]!, end: [3 + 1 / 16, 3] }],
    };
    const mismatchContours = replaceSegment(fixture.contours, 0, 0, mismatch);
    const mismatchResult = certifyMixedTransverseCubicArrangement(
      mismatchContours,
      fixture.sourceKinds,
    );
    expect(mismatchResult).toMatchObject({
      status: 'KNOT_MISMATCH',
      leaves: 0,
      pairs: 0,
      certificate: null,
    });

    const badShapeKinds = fixture.sourceKinds.map((kind, index) => kind || index === 4);
    expectFailure(mismatchContours, badShapeKinds, 'INVALID_INPUT', 'marked LINE');

    const last = fixture.contours[0]![7]!;
    const badProvenance: CubicTopologySegment = {
      ...last,
      lines: [
        {
          ...last.lines[0]!,
          provenance: { ...last.lines[0]!.provenance, sourceVerbOrdinal: 99 },
        },
      ],
    };
    const malformed = replaceSegment(fixture.contours, 0, 7, badProvenance);
    expectFailure(malformed, badShapeKinds, 'INVALID_PROVENANCE', 'wrong ordinal');

    const laterNonboolean = [...badShapeKinds] as unknown[];
    laterNonboolean[7] = 'LINE';
    expectFailure(
      fixture.contours,
      laterNonboolean as readonly boolean[],
      'INVALID_INPUT',
      'source kinds',
    );
  });

  it('retains limit precedence ahead of invalid kinds', () => {
    const fixture = fixtures[0]!;
    const invalidKinds = fixture.sourceKinds.slice(0, -1);
    const sourceCap = certifyMixedTransverseCubicArrangement(fixture.contours, invalidKinds, {
      maxCubics: 7,
    });
    expect(sourceCap).toMatchObject({
      status: 'WORK_LIMIT',
      leaves: 0,
      pairs: 0,
      certificate: null,
    });
    const invalidLimits = certifyMixedTransverseCubicArrangement(fixture.contours, invalidKinds, {
      maxPairs: -1,
    });
    expect(invalidLimits).toMatchObject({
      status: 'INVALID_LIMITS',
      leaves: 0,
      pairs: 0,
      certificate: null,
    });
  });

  it('rejects the frozen all-LINE multiple-partner contour at pair five', () => {
    const control = fixedMixedLineArrangementControl();
    const result = certifyMixedTransverseCubicArrangement(control.contours, control.sourceKinds);
    expect(result).toMatchObject({
      ok: false,
      status: 'UNRESOLVED',
      leaves: control.leaves,
      pairs: control.pairs,
      certificate: null,
    });
    expect(result.finding).toContain('multiple transverse partners');
    expect(result.finding).toContain('0,5');
  });
});

describe('P3.1h ownership, corruption detection, and recovery', () => {
  it('returns owned output that survives caller mutation and intervening failure', () => {
    const fixture = fixtures[0]!;
    const input = structuredClone(fixture.contours) as unknown as Array<
      Array<{
        cubic: Array<[number, number]>;
        sourceVerbOrdinal: number;
        lines: Array<{
          end: [number, number];
          provenance: ReferenceFlattenedLine['provenance'];
        }>;
      }>
    >;
    const first = certifyMixedTransverseCubicArrangement(
      input as unknown as Contours,
      fixture.sourceKinds,
    );
    expect(first.status).toBe('CERTIFIED');
    const certificate = first.certificate!;
    const snapshot = structuredClone(certificate);
    expect(certificate.polygons[0]![0]).not.toBe(input[0]![0]!.cubic[0]);
    expect(certificate.crossings[0]).not.toBe(fixture.expected.crossings[0]);

    input[0]![0]!.cubic[0]![0] = 999;
    input[0]![0]!.lines[0]!.end[0] = 999;
    expect(certificate).toEqual(snapshot);

    expectFailure(fixture.contours, fixture.sourceKinds.slice(1), 'INVALID_INPUT', 'source kinds');
    expect(certificate).toEqual(snapshot);
    const recovered = certifyMixedTransverseCubicArrangement(fixture.contours, fixture.sourceKinds);
    expect(recovered.certificate).toEqual(snapshot);
    expect(recovered.certificate).not.toBe(certificate);
  });

  it('is deterministic on deeply frozen positive and malformed inputs', () => {
    const fixture = structuredClone(fixtures[1]!);
    deepFreeze(fixture);
    const first = certifyMixedTransverseCubicArrangement(fixture.contours, fixture.sourceKinds);
    const second = certifyMixedTransverseCubicArrangement(fixture.contours, fixture.sourceKinds);
    expect(second).toEqual(first);
    expect(second.certificate).not.toBe(first.certificate);
    const malformed = fixture.sourceKinds.slice(1);
    expect(certifyMixedTransverseCubicArrangement(fixture.contours, malformed)).toEqual(
      certifyMixedTransverseCubicArrangement(fixture.contours, malformed),
    );
  });

  it('detects sign, index, and polygon-bit corruption against frozen expectations', () => {
    const fixture = fixtures[0]!;
    const result = certifyMixedTransverseCubicArrangement(fixture.contours, fixture.sourceKinds);
    const wrongSign = {
      ...fixture.expected,
      crossings: [{ ...fixture.expected.crossings[0]!, orientation: 1 as const }],
    };
    const wrongIndex = {
      ...fixture.expected,
      crossings: [{ ...fixture.expected.crossings[0]!, rightLeaf: 3 }],
    };
    expect(result.certificate).not.toEqual({
      polygons: wrongSign.polygons,
      crossings: wrongSign.crossings,
    });
    expect(result.certificate).not.toEqual({
      polygons: wrongIndex.polygons,
      crossings: wrongIndex.crossings,
    });
    const signedFixture = fixtures[6]!;
    const signed = certifyMixedTransverseCubicArrangement(
      signedFixture.contours,
      signedFixture.sourceKinds,
    );
    const wrongPolygonBits = signedFixture.expected.polygons.map((polygon, contourIndex) =>
      polygon.map((point, pointIndex) =>
        contourIndex === 0 && pointIndex === 0 ? ([+0, point[1]] as const) : point,
      ),
    );
    expect(polygonBits(signed.certificate!.polygons)).not.toBe(polygonBits(wrongPolygonBits));
  });
});
