import { describe, expect, it } from 'vitest';
import type { Point, ReferenceFlattenedLine } from '../../packages/geometry-reference/src/types.js';
import {
  fixedTriangleFreeArrangementFixtures,
  triangleFreeArrangementControls,
} from '../geometry/triangle-free-arrangement/fixtures.js';
import { fixedMixedLineArrangementFixtures } from '../geometry/mixed-line-arrangement/fixtures.js';
import { fixedNativeTransverseArrangementFixtureRows } from '../geometry/native-transverse-arrangement/fixtures.js';
import {
  certifyMixedTransverseCubicArrangement,
  certifyTransverseCubicArrangement,
  certifyTriangleFreeCubicArrangement,
  type CubicTopologySegment,
  type TransverseArrangementResult,
} from '../geometry/simple-cubic-topology/oracle.js';
import {
  compare,
  div,
  exactNumber,
  mul,
  rational,
  sub,
  ZERO,
  type Rational,
} from '../geometry/rounded-fill/exact.js';
import { bitsOf } from '../geometry/rounded-fill/exact.js';

type Contours = readonly (readonly CubicTopologySegment[])[];
type ExactPoint = readonly [Rational, Rational];

const fixtures = fixedTriangleFreeArrangementFixtures();
const controls = triangleFreeArrangementControls();
const UNIT = rational(1n, 1n << 1074n);

function totalSources(contours: Contours): number {
  return contours.reduce((sum, contour) => sum + contour.length, 0);
}

function allFalse(contours: Contours): readonly boolean[] {
  return Array.from({ length: totalSources(contours) }, () => false);
}

function exactPoint([x, y]: Point): ExactPoint {
  return [mul(exactNumber(x), UNIT), mul(exactNumber(y), UNIT)];
}

function cross(left: ExactPoint, right: ExactPoint): Rational {
  return sub(mul(left[0], right[1]), mul(left[1], right[0]));
}

function vector(left: ExactPoint, right: ExactPoint): ExactPoint {
  return [sub(left[0], right[0]), sub(left[1], right[1])];
}

function properChordParameter(a: Point, b: Point, c: Point, d: Point): Rational | null {
  const exactA = exactPoint(a);
  const r = vector(exactPoint(b), exactA);
  const qMinusP = vector(exactPoint(c), exactA);
  const s = vector(exactPoint(d), exactPoint(c));
  const denominator = cross(r, s);
  if (compare(denominator, ZERO) === 0) return null;
  const t = div(cross(qMinusP, s), denominator);
  const u = div(cross(qMinusP, r), denominator);
  return compare(t, ZERO) > 0 &&
    compare(t, rational(1n)) < 0 &&
    compare(u, ZERO) > 0 &&
    compare(u, rational(1n)) < 0
    ? t
    : null;
}

function directedChordPartners(
  polygons: readonly (readonly Point[])[],
  leaf: number,
): readonly number[] {
  const leaves: { start: Point; end: Point }[] = [];
  for (const polygon of polygons)
    polygon.forEach((start, index) =>
      leaves.push({ start, end: polygon[(index + 1) % polygon.length]! }),
    );
  const chosen = leaves[leaf]!;
  return leaves
    .map((candidate, partner) => ({
      partner,
      parameter:
        partner === leaf
          ? null
          : properChordParameter(chosen.start, chosen.end, candidate.start, candidate.end),
    }))
    .filter((entry): entry is { partner: number; parameter: Rational } => entry.parameter !== null)
    .sort((left, right) => compare(left.parameter, right.parameter))
    .map(({ partner }) => partner);
}

function expectResult(
  result: TransverseArrangementResult,
  expected: Readonly<{
    status: TransverseArrangementResult['status'];
    leaves: number;
    pairs: number;
    findingIncludes?: readonly string[];
  }>,
): void {
  expect(result.status).toBe(expected.status);
  expect(result.leaves).toBe(expected.leaves);
  expect(result.pairs).toBe(expected.pairs);
  for (const text of expected.findingIncludes ?? []) expect(result.finding).toContain(text);
  if (expected.status !== 'CERTIFIED') {
    expect(result.ok).toBe(false);
    expect(result.certificate).toBeNull();
  }
}

function replaceSegment(
  contours: Contours,
  contourIndex: number,
  segmentIndex: number,
  replacement: CubicTopologySegment,
): Contours {
  return contours.map((contour, currentContour) =>
    currentContour === contourIndex
      ? contour.map((segment, currentSegment) =>
          currentSegment === segmentIndex ? replacement : segment,
        )
      : contour,
  );
}

function deepFreeze(value: unknown): void {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
}

function polygonBits(polygons: readonly (readonly Point[])[]): string {
  return JSON.stringify(
    polygons.map((polygon) =>
      polygon.map(([x, y]) => [bitsOf(x).toString(16), bitsOf(y).toString(16)]),
    ),
  );
}

function assertCertificate(
  actual: NonNullable<TransverseArrangementResult['certificate']>,
  expected: Readonly<{
    polygons: readonly (readonly Point[])[];
    crossings: NonNullable<TransverseArrangementResult['certificate']>['crossings'];
  }>,
): void {
  expect(actual.crossings).toEqual(expected.crossings);
  expect(polygonBits(actual.polygons)).toBe(polygonBits(expected.polygons));
}

function assertDirectedOrders(
  polygons: readonly (readonly Point[])[],
  orders: readonly Readonly<{ leaf: number; partners: readonly number[] }>[],
): void {
  for (const order of orders)
    expect(directedChordPartners(polygons, order.leaf)).toEqual(order.partners);
}

describe('P3.1i frozen triangle-free arrangement fixtures', () => {
  it('freezes the exact eight-positive and three-control inventory', () => {
    expect(fixtures.map(({ id }) => id)).toEqual([
      'star',
      'star-reflect',
      'star-reverse',
      'star-implicit',
      'star-mixed',
      'star-lines',
      'star-curved',
      'cap-32',
    ]);
    expect(controls.map(({ id }) => id)).toEqual([
      'distinct-triangle',
      'concurrent-triangle',
      'cap-overflow',
    ]);
    expect(
      fixtures.map(({ expected }) => [expected.leaves, expected.pairs, expected.crossings.length]),
    ).toEqual([
      [7, 21, 2],
      [7, 21, 2],
      [7, 21, 2],
      [7, 21, 2],
      [7, 21, 2],
      [7, 21, 2],
      [7, 21, 2],
      [16, 120, 32],
    ]);
    expect(controls.map(({ status, leaves, pairs }) => [status, leaves, pairs])).toEqual([
      ['UNRESOLVED', 7, 13],
      ['UNRESOLVED', 7, 13],
      ['WORK_LIMIT', 16, 81],
    ]);
    expect(fixtures[3]!.contours.map((contour) => contour.length)).toEqual([2, 3]);
    expect(fixtures[4]!.sourceKinds).toEqual([true, false, false, false, false, false, false]);
    expect(fixtures[5]!.sourceKinds).toEqual([true, true, true, true, true, true, true]);
  });

  it.each(fixtures)('$id certifies literal polygons and ordered crossing records', (fixture) => {
    const result = certifyTriangleFreeCubicArrangement(fixture.contours, fixture.sourceKinds);
    expect(result).toEqual({
      ok: true,
      status: 'CERTIFIED',
      leaves: fixture.expected.leaves,
      pairs: fixture.expected.pairs,
      finding: null,
      certificate: { polygons: fixture.expected.polygons, crossings: fixture.expected.crossings },
    });
  });

  it.each(controls)('$id preserves the frozen atomic rejection', (control) => {
    const result = certifyTriangleFreeCubicArrangement(control.contours, control.sourceKinds);
    expectResult(result, control);
  });

  it('proves every star directed event order from exact chord intersection parameters', () => {
    for (const fixture of fixtures.slice(0, 7)) {
      expect(fixture.directedPartnerOrder).toHaveLength(1);
      assertDirectedOrders(fixture.expected.polygons, fixture.directedPartnerOrder ?? []);
    }
  });

  it('preserves explicit source counts, ordinals, depth-zero provenance, and curved controls', () => {
    for (const fixture of [...fixtures, ...controls]) {
      const flat = fixture.contours.flat();
      expect(flat.map(({ sourceVerbOrdinal }) => sourceVerbOrdinal)).toEqual(
        Array.from({ length: flat.length }, (_, index) => index + 1),
      );
      for (const segment of flat) {
        expect(segment.lines).toHaveLength(1);
        expect(segment.lines[0]!.provenance).toEqual({
          sourceVerbOrdinal: segment.sourceVerbOrdinal,
          endNumerator: 1,
          depth: 0,
        });
      }
    }
    expect(fixtures[6]!.contours[0]![0]!.cubic).toEqual([
      [-3, 0],
      [-1, 1 / 16],
      [1, -1 / 16],
      [3, 0],
    ]);
  });
});

describe('P3.1i compatibility and preserved matching restrictions', () => {
  it('keeps every old matching star restriction at its frozen charged pair', () => {
    for (const [index, fixture] of fixtures.slice(0, 7).entries()) {
      const expectedPairs = fixture.id === 'star-reverse' ? 14 : 6;
      if (fixture.sourceKinds.some(Boolean)) {
        expectResult(
          certifyMixedTransverseCubicArrangement(fixture.contours, fixture.sourceKinds),
          {
            status: 'UNRESOLVED',
            leaves: 7,
            pairs: expectedPairs,
            findingIncludes: ['multiple transverse partners'],
          },
        );
      } else {
        const plain = certifyTransverseCubicArrangement(fixture.contours);
        const mixed = certifyMixedTransverseCubicArrangement(
          fixture.contours,
          allFalse(fixture.contours),
        );
        expect(mixed, `${index}:${fixture.id}`).toEqual(plain);
        expectResult(plain, {
          status: 'UNRESOLVED',
          leaves: 7,
          pairs: expectedPairs,
          findingIncludes: ['multiple transverse partners'],
        });
      }
    }
  });

  it('keeps the old matching restrictions for both triangles and cap overflow', () => {
    for (const triangle of controls.slice(0, 2)) {
      const plain = certifyTransverseCubicArrangement(triangle.contours);
      const mixed = certifyMixedTransverseCubicArrangement(
        triangle.contours,
        allFalse(triangle.contours),
      );
      expect(mixed, triangle.id).toEqual(plain);
      expectResult(plain, {
        status: 'UNRESOLVED',
        leaves: 7,
        pairs: 3,
        findingIncludes: ['multiple transverse partners', '0,3'],
      });
    }
    for (const cap of [fixtures[7]!, controls[2]!]) {
      const plain = certifyTransverseCubicArrangement(cap.contours);
      const mixed = certifyMixedTransverseCubicArrangement(cap.contours, allFalse(cap.contours));
      expect(mixed, cap.id).toEqual(plain);
      expectResult(plain, {
        status: 'UNRESOLVED',
        leaves: 16,
        pairs: 9,
        findingIncludes: ['multiple transverse partners'],
      });
    }
  });

  it('matches all 24 inherited certified rows with explicit all-false kinds', () => {
    const rows = fixedNativeTransverseArrangementFixtureRows().filter(
      ({ expectation }) => expectation === 'Certified',
    );
    expect(rows).toHaveLength(24);
    for (const row of rows) {
      const oldResult = certifyTransverseCubicArrangement(row.contours);
      const result = certifyTriangleFreeCubicArrangement(row.contours, allFalse(row.contours));
      expect(result, row.id).toEqual(oldResult);
    }
  });

  it('matches all seven inherited H positives under their actual kinds', () => {
    const inherited = fixedMixedLineArrangementFixtures();
    expect(inherited).toHaveLength(7);
    for (const fixture of inherited) {
      const oldResult = certifyMixedTransverseCubicArrangement(
        fixture.contours,
        fixture.sourceKinds,
      );
      const result = certifyTriangleFreeCubicArrangement(fixture.contours, fixture.sourceKinds);
      expect(result, fixture.id).toEqual(oldResult);
    }
  });
});

describe('P3.1i limits, validation precedence, and recovery', () => {
  it('enforces every frozen inclusive and one-below limit boundary', () => {
    const star = fixtures[0]!;
    for (const [limits, leaves, pairs] of [
      [{ maxContours: 1 }, 0, 0],
      [{ maxCubics: 6 }, 0, 0],
      [{ maxLeaves: 6 }, 0, 0],
      [{ maxPairs: 20 }, 7, 20],
    ] as const)
      expectResult(certifyTriangleFreeCubicArrangement(star.contours, star.sourceKinds, limits), {
        status: 'WORK_LIMIT',
        leaves,
        pairs,
      });
    expect(
      certifyTriangleFreeCubicArrangement(star.contours, star.sourceKinds, {
        maxContours: 2,
        maxCubics: 7,
        maxLeaves: 7,
        maxPairs: 21,
      }).status,
    ).toBe('CERTIFIED');

    const implicit = fixtures[3]!;
    expectResult(
      certifyTriangleFreeCubicArrangement(implicit.contours, implicit.sourceKinds, {
        maxLeaves: 6,
      }),
      { status: 'WORK_LIMIT', leaves: 6, pairs: 0 },
    );
    expect(
      certifyTriangleFreeCubicArrangement(implicit.contours, implicit.sourceKinds, { maxLeaves: 7 })
        .status,
    ).toBe('CERTIFIED');

    const cap = fixtures[7]!;
    expectResult(
      certifyTriangleFreeCubicArrangement(cap.contours, cap.sourceKinds, { maxCubics: 15 }),
      { status: 'WORK_LIMIT', leaves: 0, pairs: 0 },
    );
    expectResult(
      certifyTriangleFreeCubicArrangement(cap.contours, cap.sourceKinds, { maxPairs: 119 }),
      { status: 'WORK_LIMIT', leaves: 16, pairs: 119 },
    );
    const overflow = controls[2]!;
    expectResult(
      certifyTriangleFreeCubicArrangement(overflow.contours, overflow.sourceKinds, {
        maxPairs: 80,
      }),
      { status: 'WORK_LIMIT', leaves: 16, pairs: 80 },
    );
    expectResult(
      certifyTriangleFreeCubicArrangement(overflow.contours, overflow.sourceKinds, {
        maxPairs: 81,
      }),
      overflow,
    );
    for (const triangle of controls.slice(0, 2)) {
      expectResult(
        certifyTriangleFreeCubicArrangement(triangle.contours, triangle.sourceKinds, {
          maxPairs: 12,
        }),
        { status: 'WORK_LIMIT', leaves: 7, pairs: 12 },
      );
      expectResult(
        certifyTriangleFreeCubicArrangement(triangle.contours, triangle.sourceKinds, {
          maxPairs: 13,
        }),
        triangle,
      );
    }
  });

  it('preserves invalid-limit and complete source-kind preflight precedence', () => {
    const fixture = fixtures[4]!;
    const sparse = new Array<boolean>(fixture.sourceKinds.length);
    for (let index = 0; index < sparse.length; index += 1) if (index !== 2) sparse[index] = false;
    const invalidKinds = [
      undefined,
      null,
      {},
      fixture.sourceKinds.slice(0, -1),
      [...fixture.sourceKinds, false],
      sparse,
      fixture.sourceKinds.map((kind, index) => (index === 2 ? 1 : kind)),
    ];
    for (const kinds of invalidKinds) {
      const supplied = kinds as readonly boolean[];
      const inherited = certifyMixedTransverseCubicArrangement(fixture.contours, supplied);
      const result = certifyTriangleFreeCubicArrangement(fixture.contours, supplied);
      expect(result).toEqual(inherited);
      expectResult(result, {
        status: 'INVALID_INPUT',
        leaves: 0,
        pairs: 0,
        findingIncludes: ['source kinds'],
      });
    }
    expectResult(certifyTriangleFreeCubicArrangement(fixture.contours, [], { maxPairs: -1 }), {
      status: 'INVALID_LIMITS',
      leaves: 0,
      pairs: 0,
    });

    const markedNonlinear = fixture.sourceKinds.map((kind, index) => kind || index === 4);
    const markedResult = certifyTriangleFreeCubicArrangement(fixture.contours, markedNonlinear);
    expect(markedResult).toEqual(
      certifyMixedTransverseCubicArrangement(fixture.contours, markedNonlinear),
    );
    expectResult(markedResult, {
      status: 'INVALID_INPUT',
      leaves: 0,
      pairs: 0,
      findingIncludes: ['marked LINE'],
    });

    const first = fixture.contours[0]![0]!;
    const split: CubicTopologySegment = {
      ...first,
      lines: [
        { end: [0, 0], provenance: { sourceVerbOrdinal: 1, endNumerator: 1, depth: 1 } },
        {
          end: first.cubic[3],
          provenance: { sourceVerbOrdinal: 1, endNumerator: 2, depth: 1 },
        },
      ],
    };
    const splitContours = replaceSegment(fixture.contours, 0, 0, split);
    const splitResult = certifyTriangleFreeCubicArrangement(splitContours, fixture.sourceKinds);
    expect(splitResult).toEqual(
      certifyMixedTransverseCubicArrangement(splitContours, fixture.sourceKinds),
    );
    expectResult(splitResult, {
      status: 'INVALID_INPUT',
      leaves: 0,
      pairs: 0,
      findingIncludes: ['marked LINE'],
    });
  });

  it('keeps provenance faults before earlier source-final mismatch and mismatch before graph work', () => {
    const fixture = fixtures[0]!;
    const first = fixture.contours[0]![0]!;
    const mismatch: CubicTopologySegment = {
      ...first,
      lines: [{ ...first.lines[0]!, end: [4, 0] }],
    };
    const mismatchContours = replaceSegment(fixture.contours, 0, 0, mismatch);
    const mismatchResult = certifyTriangleFreeCubicArrangement(
      mismatchContours,
      fixture.sourceKinds,
    );
    expect(mismatchResult).toEqual(
      certifyMixedTransverseCubicArrangement(mismatchContours, fixture.sourceKinds),
    );
    expectResult(mismatchResult, {
      status: 'KNOT_MISMATCH',
      leaves: 0,
      pairs: 0,
    });

    const last = fixture.contours[1]!.at(-1)!;
    const badProvenance: CubicTopologySegment = {
      ...last,
      lines: [
        { ...last.lines[0]!, provenance: { ...last.lines[0]!.provenance, sourceVerbOrdinal: 99 } },
      ],
    };
    const provenanceContours = replaceSegment(mismatchContours, 1, 3, badProvenance);
    const provenanceResult = certifyTriangleFreeCubicArrangement(
      provenanceContours,
      fixture.sourceKinds,
    );
    expect(provenanceResult).toEqual(
      certifyMixedTransverseCubicArrangement(provenanceContours, fixture.sourceKinds),
    );
    expectResult(provenanceResult, {
      status: 'INVALID_PROVENANCE',
      leaves: 0,
      pairs: 0,
      findingIncludes: ['wrong ordinal'],
    });

    const later = fixture.contours[1]![2]!;
    const cases: readonly Readonly<{
      replacement: CubicTopologySegment;
      status: TransverseArrangementResult['status'];
      finding: string;
    }>[] = [
      {
        replacement: { ...later, lines: null } as unknown as CubicTopologySegment,
        status: 'INVALID_INPUT',
        finding: 'lines array',
      },
      {
        replacement: {
          ...later,
          cubic: [later.cubic[0], later.cubic[1], later.cubic[2], [Number.NaN, 1]],
        },
        status: 'INVALID_INPUT',
        finding: 'cubic',
      },
      {
        replacement: {
          ...later,
          sourceVerbOrdinal: 1,
          lines: later.lines.map((line) => ({
            ...line,
            provenance: { ...line.provenance, sourceVerbOrdinal: 1 },
          })),
        },
        status: 'INVALID_INPUT',
        finding: 'ordinal',
      },
      {
        replacement: {
          ...later,
          cubic: [[99, 99], later.cubic[1], later.cubic[2], later.cubic[3]],
        },
        status: 'INVALID_INPUT',
        finding: 'connect',
      },
    ];
    for (const fault of cases) {
      const contours = replaceSegment(mismatchContours, 1, 2, fault.replacement);
      const inherited = certifyMixedTransverseCubicArrangement(contours, fixture.sourceKinds);
      const result = certifyTriangleFreeCubicArrangement(contours, fixture.sourceKinds);
      expect(result).toEqual(inherited);
      expectResult(result, {
        status: fault.status,
        leaves: 0,
        pairs: 0,
        findingIncludes: [fault.finding],
      });
    }
  });

  it('returns owned copies and remains deterministic across mutation, failure, and recovery', () => {
    const fixture = fixtures[0]!;
    const input = structuredClone(fixture.contours) as unknown as Array<
      Array<{
        cubic: Array<[number, number]>;
        sourceVerbOrdinal: number;
        lines: Array<{ end: [number, number]; provenance: ReferenceFlattenedLine['provenance'] }>;
      }>
    >;
    const first = certifyTriangleFreeCubicArrangement(
      input as unknown as Contours,
      fixture.sourceKinds,
    );
    const certificate = first.certificate!;
    const snapshot = structuredClone(certificate);
    expect(certificate.polygons[0]![0]).not.toBe(input[0]![0]!.cubic[0]);
    expect(certificate.crossings[0]).not.toBe(fixture.expected.crossings[0]);
    input[0]![0]!.cubic[0]![0] = 999;
    expect(certificate).toEqual(snapshot);
    expectResult(
      certifyTriangleFreeCubicArrangement(fixture.contours, fixture.sourceKinds.slice(1)),
      { status: 'INVALID_INPUT', leaves: 0, pairs: 0 },
    );
    expect(certificate).toEqual(snapshot);
    const frozen = structuredClone(fixture);
    deepFreeze(frozen);
    const recovered = certifyTriangleFreeCubicArrangement(frozen.contours, frozen.sourceKinds);
    expect(recovered.certificate).toEqual(snapshot);
    expect(recovered.certificate).not.toBe(certificate);
    expect(certifyTriangleFreeCubicArrangement(frozen.contours, frozen.sourceKinds)).toEqual(
      recovered,
    );
  });
});

describe('P3.1i independent fixture corruption controls', () => {
  it('rejects sign, valid index, event-order, and polygon-bit substitutions', () => {
    const fixture = fixtures[0]!;
    const actual = certifyTriangleFreeCubicArrangement(
      fixture.contours,
      fixture.sourceKinds,
    ).certificate!;
    assertCertificate(actual, fixture.expected);
    const wrongSign = fixture.expected.crossings.map((crossing, index) =>
      index === 0 ? { ...crossing, orientation: -1 as const } : crossing,
    );
    const wrongIndex = fixture.expected.crossings.map((crossing, index) =>
      index === 0 ? { ...crossing, rightLeaf: 5 } : crossing,
    );
    expect(() =>
      assertCertificate(actual, { ...fixture.expected, crossings: wrongSign }),
    ).toThrow();
    expect(() =>
      assertCertificate(actual, { ...fixture.expected, crossings: wrongIndex }),
    ).toThrow();
    expect(() =>
      assertDirectedOrders(fixture.expected.polygons, [{ leaf: 0, partners: [4, 6] }]),
    ).toThrow();
    const wrongPolygon = fixture.expected.polygons.map((polygon, contour) =>
      polygon.map((point, index) =>
        contour === 0 && index === 0 ? ([point[0], -0] as const) : point,
      ),
    );
    expect(() =>
      assertCertificate(actual, { ...fixture.expected, polygons: wrongPolygon }),
    ).toThrow();
  });
});
