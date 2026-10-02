import { describe, expect, it } from 'vitest';
import type { Cubic, ReferenceFlattenedLine } from '../../packages/geometry-reference/src/types.js';
import { certifyCubicBoundary } from '../geometry/cubic-boundary/oracle.js';
import {
  fixedRoundedKnotTopologyFixtures,
  roundedKnotMinimumLeafControls,
  roundedKnotTopologyControls,
  type RoundedKnotTopologyFixture,
} from '../geometry/rounded-knot-topology/fixtures.js';
import { simpleCubicTopologyRejectingControls } from '../geometry/simple-cubic-topology/fixtures.js';
import {
  certifyRoundedKnotCubicTopology,
  certifySimpleCubicTopology,
} from '../geometry/simple-cubic-topology/oracle.js';

type RoundedInput = Parameters<typeof certifyRoundedKnotCubicTopology>[0];
type RoundedLimits = Parameters<typeof certifyRoundedKnotCubicTopology>[1];

function fixtureById(id: string): RoundedKnotTopologyFixture {
  const fixture = fixedRoundedKnotTopologyFixtures().find((candidate) => candidate.id === id);
  if (fixture === undefined) throw new Error(`missing rounded-knot fixture ${id}`);
  return fixture;
}

function expectStatus(
  contours: RoundedInput,
  status: string,
  limits?: RoundedLimits,
  counters?: Readonly<{ leaves: number; pairs: number }>,
) {
  const result = certifyRoundedKnotCubicTopology(contours, limits);
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
  contours: RoundedInput,
  contourIndex: number,
  segmentIndex: number,
  replacement: RoundedInput[number][number],
): RoundedInput {
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

describe('P3.1f frozen rounded internal-knot fixtures', () => {
  it('freezes eleven cases, their order, literal rounded knots, and provenance', () => {
    const fixtures = fixedRoundedKnotTopologyFixtures();
    expect(fixtures.map(({ id }) => id)).toEqual([
      'rounded/identity',
      'rounded/reflect-x',
      'rounded/scale-half',
      'rounded/reverse',
      'exact/identity',
      'exact/reflect-x',
      'exact/scale-half',
      'exact/reverse',
      'rounded/four-disjoint',
      'rounded/four-disjoint-reverse-order',
      'rounded/implicit-closure',
    ]);
    const rounded = fixtureById('rounded/identity').contours[0]![0]!;
    expect(rounded.cubic).toEqual([
      [0, 0],
      [1, 2 ** -54],
      [2, 1],
      [3, 0],
    ]);
    expect(rounded.lines.slice(0, 3).map(({ end }) => end)).toEqual([
      [3 / 4, 9 / 64 + 2 ** -55],
      [3 / 2, 3 / 8],
      [9 / 4, 27 / 64],
    ]);
    expect(rounded.lines.map(({ provenance }) => provenance)).toEqual(
      [1, 2, 3, 4].map((endNumerator) => ({
        sourceVerbOrdinal: 7,
        endNumerator,
        depth: 2,
      })),
    );
    expect(rounded.lines[0]!.end).not.toEqual([3 / 4, 9 / 64]);
    expect(rounded.lines[0]!.end).not.toEqual(rounded.cubic[3]);
    expect(fixtureById('rounded/identity').expected.polygons[0]!.slice(0, 5)).toEqual([
      [0, 0],
      [3 / 4, 9 / 64 + 2 ** -55],
      [3 / 2, 3 / 8],
      [9 / 4, 27 / 64],
      [3, 0],
    ]);
    expect(fixtureById('exact/identity').contours[0]![0]!.lines[0]!.end).toEqual([3 / 4, 9 / 64]);
  });

  it('reverses the supplied actual chain and rebuilds provenance without reevaluating knots', () => {
    const forward = fixtureById('rounded/identity').contours[0]!;
    const reversed = fixtureById('rounded/reverse').contours[0]!;
    expect(reversed[2]!.lines.map(({ end }) => end)).toEqual([
      forward[0]!.lines[2]!.end,
      forward[0]!.lines[1]!.end,
      forward[0]!.lines[0]!.end,
      forward[0]!.cubic[0],
    ]);
    expect(reversed[2]!.lines.map(({ provenance }) => provenance.endNumerator)).toEqual([
      1, 2, 3, 4,
    ]);
  });

  it.each(fixedRoundedKnotTopologyFixtures())(
    '$id certifies its exact actual polygon and literal labels',
    (fixture) => {
      const result = expectStatus(fixture.contours, 'CERTIFIED');
      expect(result.certificate, fixture.id).toEqual(fixture.expected);
      const leaves = fixture.expected.polygons.reduce(
        (total, polygon) => total + polygon.length,
        0,
      );
      expect(result.leaves, fixture.id).toBe(leaves);
      expect(result.pairs, fixture.id).toBe((leaves * (leaves - 1)) / 2);
    },
  );

  it('pins orientation and winding under reflection, reversal, scale, and contour permutation', () => {
    expect(fixtureById('rounded/identity').expected.orientations).toEqual([-1]);
    expect(fixtureById('rounded/reflect-x').expected.orientations).toEqual([1]);
    expect(fixtureById('rounded/scale-half').expected.orientations).toEqual([-1]);
    expect(fixtureById('rounded/reverse').expected.orientations).toEqual([1]);
    for (const id of ['rounded/four-disjoint', 'rounded/four-disjoint-reverse-order']) {
      expect(fixtureById(id).expected).toMatchObject({
        orientations: [-1, -1, -1, -1],
        winding: [
          [0, 0, 0, 0],
          [0, 0, 0, 0],
          [0, 0, 0, 0],
          [0, 0, 0, 0],
        ],
      });
    }
  });

  it('retains exact P3.1e counterpart outcomes without changing the old certificate', () => {
    for (const fixture of fixedRoundedKnotTopologyFixtures()) {
      const old = certifySimpleCubicTopology(fixture.contours);
      expect(old.status, fixture.id).toBe(fixture.oldStatus);
      expect(old.certificate === null, fixture.id).toBe(fixture.oldStatus !== 'CERTIFIED');
    }
  });

  it('certifies every source against the unchanged P3.1d identity-screen oracle', () => {
    for (const fixture of fixedRoundedKnotTopologyFixtures()) {
      for (const segment of fixture.contours.flat()) {
        expect(
          certifyCubicBoundary({
            cubic: segment.cubic,
            lines: segment.lines,
            screen: [1, 0, 0, 1],
            sourceVerbOrdinal: segment.sourceVerbOrdinal,
          }).status,
          `${fixture.id}:${segment.sourceVerbOrdinal}`,
        ).toBe('CERTIFIED');
      }
    }
  });
});

describe('P3.1f analytic rejection and precedence controls', () => {
  it('freezes the cyclic-only mixed dyadic intervals through the final three-quarter leaf', () => {
    const cyclic = roundedKnotTopologyControls().find(({ id }) => id === 'cyclic-only-projection')!;
    expect(
      cyclic.contours[0]![2]!.lines.map(({ provenance }) => ({
        endNumerator: provenance.endNumerator,
        depth: provenance.depth,
      })),
    ).toEqual([
      { endNumerator: 1, depth: 1 },
      { endNumerator: 3, depth: 2 },
      { endNumerator: 4, depth: 2 },
    ]);
    expect(certifySimpleCubicTopology(cyclic.contours).status).toBe('CERTIFIED');
  });

  it('carries a signed-zero actual source endpoint across the next source boundary', () => {
    const base = fixtureById('rounded/identity').contours;
    const first = base[0]![0]!;
    const contours = replaceSegment(base, 0, 0, {
      ...first,
      lines: [...first.lines.slice(0, -1), { ...first.lines.at(-1)!, end: [3, -0] as const }],
    });
    const result = expectStatus(contours, 'CERTIFIED', undefined, { leaves: 12, pairs: 66 });
    expect(Object.is(result.certificate!.polygons[0]![4]![1], -0)).toBe(true);
  });

  it.each(roundedKnotTopologyControls())(
    '$id returns its frozen status, counters, and finding class',
    (control) => {
      const result = expectStatus(control.contours, control.status, undefined, control);
      if (control.findingIncludes !== undefined)
        expect(result.finding, control.id).toContain(control.findingIncludes);
      if (control.id === 'cyclic-only-projection') expect(result.finding).toContain('0,5');
    },
  );

  it('retains all named P3.1e geometric rejections under expanded hulls', () => {
    for (const control of simpleCubicTopologyRejectingControls()) {
      const result = expectStatus(control.contours, 'UNRESOLVED');
      if (['tiny-zero-chord-loop', 'negative-projection'].includes(control.id)) {
        expect(result.leaves, control.id).toBe(control.id === 'tiny-zero-chord-loop' ? 1 : 2);
        expect(result.pairs, control.id).toBe(0);
      } else {
        expect(result.leaves, control.id).toBeGreaterThanOrEqual(4);
        expect(result.pairs, control.id).toBeGreaterThan(0);
      }
    }
  });

  it.each(roundedKnotMinimumLeafControls())(
    '$id preserves every source leaf before the minimum-three-leaf rejection',
    (control) => {
      expectStatus(control.contours, control.status, undefined, control);
    },
  );

  it('completes global preflight before a source-end mismatch', () => {
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
});

describe('P3.1f limits, malformed input, determinism, and ownership', () => {
  it('enforces the exact single-triangle and four-copy inclusive ceilings', () => {
    const single = fixtureById('rounded/identity');
    expectStatus(
      single.contours,
      'CERTIFIED',
      { maxLeaves: 12, maxPairs: 66 },
      {
        leaves: 12,
        pairs: 66,
      },
    );
    expectStatus(single.contours, 'WORK_LIMIT', { maxLeaves: 11 }, { leaves: 0, pairs: 0 });
    expectStatus(single.contours, 'WORK_LIMIT', { maxPairs: 65 }, { leaves: 12, pairs: 65 });

    const four = fixtureById('rounded/four-disjoint');
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

  it('charges an implicit closure only after all eight source leaves fit', () => {
    const closure = fixtureById('rounded/implicit-closure');
    expectStatus(
      closure.contours,
      'CERTIFIED',
      { maxLeaves: 9, maxPairs: 36 },
      {
        leaves: 9,
        pairs: 36,
      },
    );
    expectStatus(closure.contours, 'WORK_LIMIT', { maxLeaves: 8 }, { leaves: 8, pairs: 0 });
  });

  it('validates every limit before malformed input', () => {
    const invalid: RoundedLimits[] = [
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

  it('rejects malformed, sparse, nonfinite, ordinal, chain, and provenance input at zero work', () => {
    const valid = fixtureById('rounded/identity').contours;
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
      [[{ ...first, lines: new Array(4) }]],
      replaceSegment(valid, 0, 1, { ...second, sourceVerbOrdinal: first.sourceVerbOrdinal }),
      replaceSegment(valid, 0, 1, { ...second, cubic: disconnected }),
    ];
    for (const candidate of invalidInput)
      expectStatus(candidate as RoundedInput, 'INVALID_INPUT', undefined, { leaves: 0, pairs: 0 });

    for (const replacement of [
      { ...first, sourceVerbOrdinal: 99 },
      { ...first, lines: first.lines.slice(1) },
      { ...first, lines: first.lines.slice(0, -1) },
      { ...first, lines: [first.lines[0]!, first.lines[0]!, ...first.lines.slice(1)] },
    ])
      expectStatus(replaceSegment(valid, 0, 0, replacement), 'INVALID_PROVENANCE', undefined, {
        leaves: 0,
        pairs: 0,
      });
  });

  it('checks excess declared counts before malformed excess contents', () => {
    const four = fixtureById('rounded/four-disjoint');
    const malformed = { cubic: null, sourceVerbOrdinal: -1, lines: new Array(100) };
    expectStatus(
      [...four.contours, [malformed]] as unknown as RoundedInput,
      'WORK_LIMIT',
      undefined,
      {
        leaves: 0,
        pairs: 0,
      },
    );
    expectStatus(
      [
        [...four.contours.flat(), ...Array.from({ length: 5 }, () => malformed)],
      ] as unknown as RoundedInput,
      'WORK_LIMIT',
      undefined,
      { leaves: 0, pairs: 0 },
    );
    const last = four.contours.at(-1)!.at(-1)!;
    const excessLines = [...last.lines, ...(new Array(17) as ReferenceFlattenedLine[])];
    expectStatus(
      replaceSegment(four.contours, 3, 2, { ...last, lines: excessLines }),
      'WORK_LIMIT',
      undefined,
      { leaves: 0, pairs: 0 },
    );
  });

  it('is deterministic, leaves deeply frozen input unchanged, and never publishes partial output', () => {
    const contours = structuredClone(fixtureById('rounded/four-disjoint').contours);
    deepFreeze(contours);
    const first = certifyRoundedKnotCubicTopology(contours);
    const second = certifyRoundedKnotCubicTopology(contours);
    expect(first).toEqual(second);
    for (const control of [...roundedKnotTopologyControls(), ...roundedKnotMinimumLeafControls()]) {
      const result = certifyRoundedKnotCubicTopology(control.contours);
      expect(result.ok, control.id).toBe(false);
      expect(result.certificate, control.id).toBeNull();
    }
  });

  it('returns certificate point tuples owned independently from caller arrays', () => {
    const contours = structuredClone(fixtureById('rounded/identity').contours) as unknown as Array<
      Array<{
        cubic: Array<[number, number]>;
        sourceVerbOrdinal: number;
        lines: Array<{ end: [number, number]; provenance: ReferenceFlattenedLine['provenance'] }>;
      }>
    >;
    const result = certifyRoundedKnotCubicTopology(contours as unknown as RoundedInput);
    expect(result.status).toBe('CERTIFIED');
    expect(result.certificate!.polygons[0]![0]).not.toBe(contours[0]![0]!.cubic[0]);
    expect(result.certificate!.polygons[0]![1]).not.toBe(contours[0]![0]!.lines[0]!.end);
    const snapshot = structuredClone(result.certificate);
    contours[0]![0]!.cubic[0]![0] = 999;
    contours[0]![0]!.lines[0]!.end[0] = 999;
    expect(result.certificate).toEqual(snapshot);
  });
});
