import { describe, expect, it } from 'vitest';
import type {
  Cubic,
  Point,
  ReferenceFlattenedLine,
} from '../../packages/geometry-reference/src/types.js';
import {
  fixedRoundedKnotTopologyFixtures,
  roundedKnotMinimumLeafControls,
  roundedKnotTopologyControls,
} from '../geometry/rounded-knot-topology/fixtures.js';
import {
  fixedTransverseArrangementFixtures,
  transverseArrangementControls,
  type TransverseArrangementFixture,
} from '../geometry/transverse-arrangement/fixtures.js';
import {
  certifyRoundedKnotCubicTopology,
  certifySimpleCubicTopology,
  certifyTransverseCubicArrangement,
} from '../geometry/simple-cubic-topology/oracle.js';

type ArrangementInput = Parameters<typeof certifyTransverseCubicArrangement>[0];
type ArrangementLimits = Parameters<typeof certifyTransverseCubicArrangement>[1];

function fixtureById(id: string): TransverseArrangementFixture {
  const fixture = fixedTransverseArrangementFixtures().find((candidate) => candidate.id === id);
  if (fixture === undefined) throw new Error(`missing transverse-arrangement fixture ${id}`);
  return fixture;
}

function expectStatus(
  contours: ArrangementInput,
  status: string,
  limits?: ArrangementLimits,
  counters?: Readonly<{ leaves: number; pairs: number }>,
) {
  const result = certifyTransverseCubicArrangement(contours, limits);
  expect(result.status).toBe(status);
  expect(result.ok).toBe(status === 'CERTIFIED');
  expect(result.finding === null).toBe(status === 'CERTIFIED');
  expect(result.certificate === null).toBe(status !== 'CERTIFIED');
  if (counters !== undefined) {
    expect(result.leaves).toBe(counters.leaves);
    expect(result.pairs).toBe(counters.pairs);
  }
  return result;
}

function replaceSegment(
  contours: ArrangementInput,
  contourIndex: number,
  segmentIndex: number,
  replacement: ArrangementInput[number][number],
): ArrangementInput {
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
  for (const child of Object.values(value)) deepFreeze(child);
  Object.freeze(value);
}

function signedAreaTwice(polygon: readonly Point[]): number {
  let area = 0;
  for (let index = 0; index < polygon.length; index += 1) {
    const current = polygon[index]!;
    const next = polygon[(index + 1) % polygon.length]!;
    area += current[0] * next[1] - current[1] * next[0];
  }
  return area;
}

describe('P3.1g frozen transverse arrangement positives', () => {
  it('freezes twelve new cases, order, literal crossing identities, and curved controls', () => {
    const fixtures = fixedTransverseArrangementFixtures();
    expect(fixtures.map(({ id }) => id)).toEqual([
      'B-explicit',
      'B-reflect-x',
      'B-reverse',
      'N-explicit',
      'N-reflect-x',
      'N-reverse',
      'B-implicit',
      'N-implicit',
      'closure-crossing',
      'closure-crossing-curved',
      'overlapping-squares',
      'overlapping-squares-reflect-x',
    ]);
    expect(fixtureById('B-explicit').expected.crossings).toEqual([
      { leftLeaf: 0, rightLeaf: 4, orientation: -1 },
    ]);
    expect(fixtureById('B-reverse').expected.crossings).toEqual([
      { leftLeaf: 3, rightLeaf: 7, orientation: 1 },
    ]);
    expect(fixtureById('overlapping-squares').expected.crossings).toEqual([
      { leftLeaf: 0, rightLeaf: 7, orientation: -1 },
      { leftLeaf: 1, rightLeaf: 6, orientation: 1 },
    ]);
    expect(fixtureById('N-explicit').contours[0]![0]!.cubic).toEqual([
      [-2, -2],
      [-1, -15 / 16],
      [1, 15 / 16],
      [2, 2],
    ]);
    expect(fixtureById('N-explicit').contours[0]![4]!.cubic).toEqual([
      [-2, 2],
      [-1, 17 / 16],
      [1, -17 / 16],
      [2, -2],
    ]);
    expect(fixtureById('closure-crossing-curved').contours[0]![3]!.cubic).toEqual([
      [-2, 2],
      [-1, 17 / 16],
      [1, -17 / 16],
      [2, -2],
    ]);

    for (const id of ['B-implicit', 'N-implicit', 'closure-crossing', 'closure-crossing-curved']) {
      const fixture = fixtureById(id);
      const contour = fixture.contours[0]!;
      expect(contour, id).toHaveLength(7);
      expect(contour.at(-1)!.lines.at(-1)!.end, id).not.toEqual(contour[0]!.cubic[0]);
      expect(fixture.expected.leaves, id).toBe(8);
    }
    for (const id of ['closure-crossing', 'closure-crossing-curved'])
      expect(fixtureById(id).expected.crossings[0]!.rightLeaf, id).toBe(7);
  });

  it.each(fixedTransverseArrangementFixtures())(
    '$id certifies exact literal polygons, crossings, and counters',
    (fixture) => {
      deepFreeze(fixture.contours);
      const result = expectStatus(fixture.contours, 'CERTIFIED', undefined, fixture.expected);
      expect(result.certificate, fixture.id).toEqual({
        polygons: fixture.expected.polygons,
        crossings: fixture.expected.crossings,
      });
    },
  );

  it('accepts zero-area crossing contours without publishing orientation or nesting labels', () => {
    for (const id of [
      'B-explicit',
      'B-reflect-x',
      'B-reverse',
      'N-explicit',
      'N-reflect-x',
      'N-reverse',
      'B-implicit',
      'N-implicit',
      'closure-crossing',
      'closure-crossing-curved',
    ]) {
      const fixture = fixtureById(id);
      expect(signedAreaTwice(fixture.expected.polygons[0]!), id).toBe(0);
      const certificate = certifyTransverseCubicArrangement(fixture.contours).certificate!;
      expect(Object.keys(certificate).sort(), id).toEqual(['crossings', 'polygons']);
      expect('orientations' in certificate, id).toBe(false);
      expect('winding' in certificate, id).toBe(false);
      expect('nesting' in certificate, id).toBe(false);
    }
  });

  it('preserves all eleven rounded positives and their old oracle certificates', () => {
    const rounded = fixedRoundedKnotTopologyFixtures();
    expect(rounded).toHaveLength(11);
    for (const fixture of rounded) {
      deepFreeze(fixture.contours);
      const oldResult = certifyRoundedKnotCubicTopology(fixture.contours);
      expect(oldResult.status, fixture.id).toBe('CERTIFIED');
      expect(oldResult.certificate, fixture.id).toEqual(fixture.expected);
      const leaves = fixture.expected.polygons.reduce((sum, polygon) => sum + polygon.length, 0);
      const result = expectStatus(fixture.contours, 'CERTIFIED', undefined, {
        leaves,
        pairs: (leaves * (leaves - 1)) / 2,
      });
      expect(result.certificate, fixture.id).toEqual({
        polygons: fixture.expected.polygons,
        crossings: [],
      });
    }
    expect(fixedTransverseArrangementFixtures().length + rounded.length).toBe(23);
  });

  it('leaves both older topology oracles rejecting the twelve crossing candidates', () => {
    for (const fixture of fixedTransverseArrangementFixtures()) {
      expect(certifySimpleCubicTopology(fixture.contours).status, fixture.id).toBe('UNRESOLVED');
      expect(certifyRoundedKnotCubicTopology(fixture.contours).status, fixture.id).toBe(
        'UNRESOLVED',
      );
    }
  });
});

describe('P3.1g rejection, precedence, and inclusive limits', () => {
  it('freezes five new rejection IDs and their exact first findings', () => {
    const controls = transverseArrangementControls();
    expect(controls.map(({ id }) => id)).toEqual([
      'multiple-partners',
      'triple-coincidence',
      'tangent-displaced-knot',
      'coincident-squares',
      'contact-squares',
    ]);
    for (const control of controls) {
      deepFreeze(control.contours);
      const result = expectStatus(control.contours, control.status, undefined, control);
      for (const fragment of control.findingIncludes)
        expect(result.finding, control.id).toContain(fragment);
    }
  });

  it('retains all eight rounded and two minimum-leaf rejection outcomes', () => {
    const inherited = [...roundedKnotTopologyControls(), ...roundedKnotMinimumLeafControls()];
    expect(inherited).toHaveLength(10);
    for (const control of inherited) {
      deepFreeze(control.contours);
      const oldResult = certifyRoundedKnotCubicTopology(control.contours);
      expect(oldResult.status, control.id).toBe(control.status);
      expect(oldResult.leaves, control.id).toBe(control.leaves);
      expect(oldResult.pairs, control.id).toBe(control.pairs);
      const result = expectStatus(control.contours, control.status, undefined, control);
      if (control.findingIncludes !== undefined)
        expect(result.finding, control.id).toContain(control.findingIncludes);
    }
    expect(transverseArrangementControls().length + inherited.length).toBe(15);
  });

  it('enforces B explicit, B implicit, two-contour, and inherited four-copy caps exactly', () => {
    const explicit = fixtureById('B-explicit');
    expectStatus(
      explicit.contours,
      'CERTIFIED',
      { maxContours: 1, maxCubics: 8, maxLeaves: 8, maxPairs: 28 },
      explicit.expected,
    );
    expectStatus(explicit.contours, 'INVALID_LIMITS', { maxContours: 0 }, { leaves: 0, pairs: 0 });
    expectStatus(explicit.contours, 'WORK_LIMIT', { maxCubics: 7 }, { leaves: 0, pairs: 0 });
    expectStatus(explicit.contours, 'WORK_LIMIT', { maxLeaves: 7 }, { leaves: 0, pairs: 0 });
    expectStatus(explicit.contours, 'WORK_LIMIT', { maxPairs: 27 }, { leaves: 8, pairs: 27 });

    const squares = fixtureById('overlapping-squares');
    expectStatus(squares.contours, 'WORK_LIMIT', { maxContours: 1 }, { leaves: 0, pairs: 0 });

    const implicit = fixtureById('B-implicit');
    expectStatus(implicit.contours, 'WORK_LIMIT', { maxLeaves: 7 }, { leaves: 7, pairs: 0 });
    expectStatus(implicit.contours, 'CERTIFIED', { maxLeaves: 8, maxPairs: 28 }, implicit.expected);

    const four = fixedRoundedKnotTopologyFixtures().find(
      ({ id }) => id === 'rounded/four-disjoint',
    )!;
    expectStatus(
      four.contours,
      'CERTIFIED',
      { maxContours: 4, maxCubics: 12, maxLeaves: 48, maxPairs: 1128 },
      { leaves: 48, pairs: 1128 },
    );
    expectStatus(four.contours, 'WORK_LIMIT', { maxContours: 3 }, { leaves: 0, pairs: 0 });
    expectStatus(four.contours, 'WORK_LIMIT', { maxCubics: 11 }, { leaves: 0, pairs: 0 });
    expectStatus(four.contours, 'WORK_LIMIT', { maxLeaves: 47 }, { leaves: 0, pairs: 0 });
    expectStatus(four.contours, 'WORK_LIMIT', { maxPairs: 1127 }, { leaves: 48, pairs: 1127 });
  });

  it('validates every limit before malformed input', () => {
    const invalid: ArrangementLimits[] = [
      { maxContours: 0 },
      { maxContours: 5 },
      { maxCubics: 0 },
      { maxCubics: 17 },
      { maxLeaves: 0 },
      { maxLeaves: 65 },
      { maxPairs: -1 },
      { maxPairs: 2017 },
      { maxContours: 1.5 },
      { maxCubics: Number.NaN },
      { maxLeaves: Number.POSITIVE_INFINITY },
    ];
    for (const limits of invalid)
      expectStatus([], 'INVALID_LIMITS', limits, { leaves: 0, pairs: 0 });
  });

  it('preserves malformed/global provenance precedence over a source-end mismatch', () => {
    const mismatch = roundedKnotTopologyControls().find(({ id }) => id === 'source-end-mismatch')!;
    const last = mismatch.contours[0]!.at(-1)!;
    const badProvenance = {
      ...last,
      lines: [
        ...last.lines.slice(0, -1),
        { ...last.lines.at(-1)!, provenance: null } as unknown as ReferenceFlattenedLine,
      ],
    };
    expectStatus(
      replaceSegment(mismatch.contours, 0, mismatch.contours[0]!.length - 1, badProvenance),
      'INVALID_PROVENANCE',
      undefined,
      { leaves: 0, pairs: 0 },
    );
    const badInput = {
      ...last,
      lines: [...last.lines.slice(0, -1), { ...last.lines.at(-1)!, end: [Number.NaN, 0] as const }],
    };
    expectStatus(
      replaceSegment(mismatch.contours, 0, mismatch.contours[0]!.length - 1, badInput),
      'INVALID_INPUT',
      undefined,
      { leaves: 0, pairs: 0 },
    );
  });

  it('retains malformed, sparse, ordinal, connectivity, provenance, and declared-cap policy', () => {
    const valid = fixtureById('B-explicit').contours;
    const first = valid[0]![0]!;
    const second = valid[0]![1]!;
    const sparseOuter = new Array<readonly (typeof first)[]>(2);
    sparseOuter[0] = valid[0]!;
    const sparseContour = new Array<typeof first>(2);
    sparseContour[0] = first;
    const disconnected: Cubic = [[99, 99], second.cubic[1], second.cubic[2], second.cubic[3]];
    const invalidInput: unknown[] = [
      [],
      [[]],
      sparseOuter,
      [sparseContour],
      [[{ ...first, cubic: new Array(4) }]],
      [[{ ...first, cubic: [first.cubic[0], first.cubic[1], first.cubic[2], [Number.NaN, 0]] }]],
      [[{ ...first, lines: new Array(1) }]],
      replaceSegment(valid, 0, 1, { ...second, sourceVerbOrdinal: first.sourceVerbOrdinal }),
      replaceSegment(valid, 0, 1, {
        ...second,
        cubic: disconnected,
      }),
    ];
    for (const candidate of invalidInput)
      expectStatus(candidate as ArrangementInput, 'INVALID_INPUT', undefined, {
        leaves: 0,
        pairs: 0,
      });

    for (const replacement of [
      {
        ...first,
        lines: [
          {
            ...first.lines[0]!,
            provenance: { ...first.lines[0]!.provenance, sourceVerbOrdinal: 99 },
          },
        ],
      },
      {
        ...first,
        lines: [
          {
            ...first.lines[0]!,
            provenance: { ...first.lines[0]!.provenance, endNumerator: 1, depth: 1 },
          },
        ],
      },
      { ...first, lines: [...first.lines, first.lines[0]!] },
    ])
      expectStatus(replaceSegment(valid, 0, 0, replacement), 'INVALID_PROVENANCE', undefined, {
        leaves: 0,
        pairs: 0,
      });

    const four = fixedRoundedKnotTopologyFixtures().find(
      ({ id }) => id === 'rounded/four-disjoint',
    )!;
    const malformed = { cubic: null, sourceVerbOrdinal: -1, lines: new Array(100) };
    expectStatus(
      [...four.contours, [malformed]] as unknown as ArrangementInput,
      'WORK_LIMIT',
      undefined,
      { leaves: 0, pairs: 0 },
    );
    expectStatus(
      [
        [...four.contours.flat(), ...Array.from({ length: 5 }, () => malformed)],
      ] as unknown as ArrangementInput,
      'WORK_LIMIT',
      undefined,
      { leaves: 0, pairs: 0 },
    );
  });
});

describe('P3.1g determinism, frozen ownership, and atomic recovery', () => {
  it('is deterministic on deeply frozen successes and failures with no partial certificate', () => {
    const success = structuredClone(fixtureById('overlapping-squares').contours);
    deepFreeze(success);
    const first = certifyTransverseCubicArrangement(success);
    const second = certifyTransverseCubicArrangement(success);
    expect(first).toEqual(second);
    expect(first.certificate).not.toBe(second.certificate);
    expect(first.certificate!.polygons[0]).not.toBe(second.certificate!.polygons[0]);
    expect(first.certificate!.crossings[0]).not.toBe(second.certificate!.crossings[0]);

    for (const control of [
      ...transverseArrangementControls(),
      ...roundedKnotTopologyControls(),
      ...roundedKnotMinimumLeafControls(),
    ]) {
      deepFreeze(control.contours);
      const failure = certifyTransverseCubicArrangement(control.contours);
      expect(certifyTransverseCubicArrangement(control.contours), control.id).toEqual(failure);
      expect(failure.ok, control.id).toBe(false);
      expect(failure.certificate, control.id).toBeNull();
    }
  });

  it('returns fresh owned polygons/crossings and preserves earlier certificates through failures', () => {
    const fixture = fixtureById('overlapping-squares');
    const contours = structuredClone(fixture.contours) as unknown as Array<
      Array<{
        cubic: Array<[number, number]>;
        sourceVerbOrdinal: number;
        lines: Array<{ end: [number, number]; provenance: ReferenceFlattenedLine['provenance'] }>;
      }>
    >;
    const success = certifyTransverseCubicArrangement(contours as unknown as ArrangementInput);
    expect(success.status).toBe('CERTIFIED');
    const certificate = success.certificate!;
    const snapshot = structuredClone(certificate);
    expect(certificate.polygons[0]![0]).not.toBe(contours[0]![0]!.cubic[0]);
    expect(certificate.crossings[0]).not.toBe(fixture.expected.crossings[0]);

    contours[0]![0]!.cubic[0]![0] = 999;
    contours[0]![0]!.lines[0]!.end[0] = 999;
    expect(certificate).toEqual(snapshot);

    const failure = transverseArrangementControls()[0]!;
    expectStatus(failure.contours, failure.status, undefined, failure);
    expectStatus(fixture.contours, 'WORK_LIMIT', { maxPairs: 27 }, { leaves: 8, pairs: 27 });
    expect(certificate).toEqual(snapshot);

    const recovered = certifyTransverseCubicArrangement(fixture.contours);
    expect(recovered.status).toBe('CERTIFIED');
    expect(recovered.certificate).toEqual(snapshot);
    expect(recovered.certificate).not.toBe(certificate);
  });
});
