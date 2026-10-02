import { describe, expect, it } from 'vitest';
import type { Cubic, ReferenceFlattenedLine } from '../../packages/geometry-reference/src/types.js';
import { certifyCubicBoundary } from '../geometry/cubic-boundary/oracle.js';
import {
  fixedSimpleCubicTopologyFixtures,
  simpleCubicTopologyRejectingControls,
  type CubicTopologySegmentFixture,
  type SimpleCubicTopologyFixture,
} from '../geometry/simple-cubic-topology/fixtures.js';
import { certifySimpleCubicTopology } from '../geometry/simple-cubic-topology/oracle.js';

type TopologyInput = Parameters<typeof certifySimpleCubicTopology>[0];
type TopologyLimits = Parameters<typeof certifySimpleCubicTopology>[1];

function fixtureById(id: string): SimpleCubicTopologyFixture {
  const fixture = fixedSimpleCubicTopologyFixtures().find((candidate) => candidate.id === id);
  if (fixture === undefined) throw new Error(`missing fixture ${id}`);
  return fixture;
}

function expectStatus(
  contours: TopologyInput,
  status: string,
  limits?: TopologyLimits,
  counters?: Readonly<{ leaves: number; pairs: number }>,
) {
  const result = certifySimpleCubicTopology(contours, limits);
  expect(result.status).toBe(status);
  expect(result.ok).toBe(status === 'CERTIFIED');
  expect(result.finding === null).toBe(status === 'CERTIFIED');
  if (status === 'CERTIFIED') expect(result.certificate).not.toBeNull();
  else expect(result.certificate).toBeNull();
  if (counters !== undefined) {
    expect(result.leaves).toBe(counters.leaves);
    expect(result.pairs).toBe(counters.pairs);
  }
  return result;
}

function nextUpPositive(value: number): number {
  if (!(value > 0) || !Number.isFinite(value)) throw new Error('positive finite value required');
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, value, false);
  view.setBigUint64(0, view.getBigUint64(0, false) + 1n, false);
  return view.getFloat64(0, false);
}

function replaceSegment(
  fixture: SimpleCubicTopologyFixture,
  contourIndex: number,
  segmentIndex: number,
  replacement: CubicTopologySegmentFixture,
): TopologyInput {
  return fixture.contours.map((contour, currentContour) =>
    currentContour === contourIndex
      ? contour.map((segment, currentSegment) =>
          currentSegment === segmentIndex ? replacement : segment,
        )
      : contour,
  );
}

describe('P3.1e frozen simple cubic topology fixtures', () => {
  it('freezes all 47 cases, transform order, permutations, and extreme squares', () => {
    const fixtures = fixedSimpleCubicTopologyFixtures();
    expect(fixtures).toHaveLength(47);
    const transforms = ['identity', 'translate', 'reflect', 'scale-half', 'reverse'];
    for (let base = 0; base < 8; base += 1) {
      for (let transform = 0; transform < transforms.length; transform += 1) {
        expect(fixtures[base * 5 + transform]!.id).toBe(
          `C${String(base + 1).padStart(2, '0')}/${transforms[transform]}`,
        );
      }
    }
    expect(fixtures.slice(40).map(({ id }) => id)).toEqual([
      'C02/reverse-contour-order',
      'C03/reverse-contour-order',
      'C05/reverse-contour-order',
      'C06/reverse-contour-order',
      'C07/reverse-contour-order',
      'extreme/min-subnormal-square',
      'extreme/large-square',
    ]);

    const first = fixtures[0]!;
    expect(first.contours[0]![0]!.cubic).toEqual([
      [4, 0],
      [4, 2],
      [2, 4],
      [0, 4],
    ]);
    expect(first.contours[0]!.map(({ sourceVerbOrdinal }) => sourceVerbOrdinal)).toEqual([
      7, 8, 9, 10,
    ]);
    expect(first.contours[0]!.every(({ lines }) => lines.length === 4)).toBe(true);

    for (const fixture of fixtures) {
      const segments = fixture.contours.flat();
      expect(segments.map(({ sourceVerbOrdinal }) => sourceVerbOrdinal)).toEqual(
        segments.map((_, index) => index + 7),
      );
      expect(new Set(segments.map(({ sourceVerbOrdinal }) => sourceVerbOrdinal)).size).toBe(
        segments.length,
      );
    }

    for (const fixture of fixtures.slice(0, 45))
      expect(fixture.contours.flat().every(({ lines }) => lines.length === 4)).toBe(true);
    for (const fixture of fixtures.slice(45))
      expect(fixture.contours.flat().every(({ lines }) => lines.length === 1)).toBe(true);
  });

  it('retains the literal integer-multiple extreme-square controls', () => {
    for (const [id, a] of [
      ['extreme/min-subnormal-square', Number.MIN_VALUE],
      ['extreme/large-square', 2 ** 1021],
    ] as const) {
      const contour = fixtureById(id).contours[0]!;
      expect(contour.map(({ cubic }) => cubic)).toEqual([
        [
          [0, 0],
          [a, 0],
          [2 * a, 0],
          [3 * a, 0],
        ],
        [
          [3 * a, 0],
          [3 * a, a],
          [3 * a, 2 * a],
          [3 * a, 3 * a],
        ],
        [
          [3 * a, 3 * a],
          [2 * a, 3 * a],
          [a, 3 * a],
          [0, 3 * a],
        ],
        [
          [0, 3 * a],
          [0, 2 * a],
          [0, a],
          [0, 0],
        ],
      ]);
      expect(
        contour.every(
          ({ cubic, lines, sourceVerbOrdinal }) =>
            lines.length === 1 &&
            lines[0]!.end === cubic[3] &&
            lines[0]!.provenance.sourceVerbOrdinal === sourceVerbOrdinal &&
            lines[0]!.provenance.endNumerator === 1 &&
            lines[0]!.provenance.depth === 0,
        ),
      ).toBe(true);
    }
  });

  it.each(fixedSimpleCubicTopologyFixtures())(
    '$id certifies its analytic polygon, orientation, and winding labels',
    (fixture) => {
      const result = expectStatus(fixture.contours, 'CERTIFIED');
      expect(result.certificate, fixture.id).toEqual(fixture.expected);
      const expectedLeaves = fixture.expected.polygons.reduce(
        (sum, polygon) => sum + polygon.length,
        0,
      );
      expect(result.leaves, fixture.id).toBe(expectedLeaves);
      expect(result.pairs, fixture.id).toBe((expectedLeaves * (expectedLeaves - 1)) / 2);
    },
  );

  it('pins orientation and both winding dimensions under reflection, reversal, and permutation', () => {
    expect(fixtureById('C03/identity').expected).toMatchObject({
      orientations: [1, -1],
      winding: [
        [0, 0],
        [1, 0],
      ],
    });
    expect(fixtureById('C03/reflect').expected).toMatchObject({
      orientations: [-1, 1],
      winding: [
        [0, 0],
        [-1, 0],
      ],
    });
    expect(fixtureById('C03/reverse').expected).toMatchObject({
      orientations: [-1, 1],
      winding: [
        [0, 0],
        [-1, 0],
      ],
    });
    expect(fixtureById('C03/reverse-contour-order').expected).toMatchObject({
      orientations: [-1, 1],
      winding: [
        [0, 1],
        [0, 0],
      ],
    });
    expect(fixtureById('C07/reverse-contour-order').expected).toMatchObject({
      orientations: [1, -1, 1],
      winding: [
        [0, -1, 1],
        [0, 0, 1],
        [0, 0, 0],
      ],
    });
  });

  it('counts the open C04 implicit closure as its thirteenth leaf', () => {
    const fixture = fixtureById('C04/identity');
    const result = expectStatus(fixture.contours, 'CERTIFIED', undefined, {
      leaves: 13,
      pairs: 78,
    });
    expect(result.certificate!.polygons[0]).toHaveLength(13);
  });

  it('also certifies every source cubic against the unchanged P3.1d identity-screen oracle', () => {
    for (const fixture of fixedSimpleCubicTopologyFixtures()) {
      for (const segment of fixture.contours.flat()) {
        const result = certifyCubicBoundary({
          cubic: segment.cubic,
          lines: segment.lines,
          screen: [1, 0, 0, 1],
          sourceVerbOrdinal: segment.sourceVerbOrdinal,
        });
        expect(result.status, `${fixture.id}:${segment.sourceVerbOrdinal}`).toBe('CERTIFIED');
      }
    }
  });
});

describe('P3.1e analytic rejecting controls', () => {
  it('rejects zero chord and negative projection before appending a hull', () => {
    const controls = simpleCubicTopologyRejectingControls();
    for (const id of ['tiny-zero-chord-loop', 'negative-projection']) {
      const control = controls.find((candidate) => candidate.id === id)!;
      expectStatus(control.contours, 'UNRESOLVED', undefined, { leaves: 0, pairs: 0 });
    }
    const tiny = controls.find(({ id }) => id === 'tiny-zero-chord-loop')!;
    const segment = tiny.contours[0]![0]!;
    expect(
      certifyCubicBoundary({
        cubic: segment.cubic,
        lines: segment.lines,
        screen: [1, 0, 0, 1],
        sourceVerbOrdinal: segment.sourceVerbOrdinal,
      }).status,
    ).toBe('CERTIFIED');
  });

  it('rejects proper crossing, endpoint contact, coincidence, and proven near hull overlap', () => {
    const controls = simpleCubicTopologyRejectingControls();
    const bowtie = controls.find(({ id }) => id === 'bowtie-crossing')!;
    expectStatus(bowtie.contours, 'UNRESOLVED', undefined, { leaves: 4, pairs: 2 });
    const adjacent = controls.find(({ id }) => id === 'adjacent-collinear-overlap')!;
    expectStatus(adjacent.contours, 'UNRESOLVED', undefined, { leaves: 4, pairs: 1 });

    for (const id of [
      'cross-contour-contact',
      'coincident-contours',
      'near-contact-hull-overlap',
    ]) {
      const control = controls.find((candidate) => candidate.id === id)!;
      const result = expectStatus(control.contours, 'UNRESOLVED');
      expect(result.leaves, id).toBe(32);
      expect(result.pairs, id).toBeGreaterThan(0);
    }
  });

  it('does not treat a two-leaf retrace as a simple closed polygon', () => {
    const cubic = [
      [0, 0],
      [1, 0],
      [2, 0],
      [3, 0],
    ] as const satisfies Cubic;
    const segment = {
      cubic,
      sourceVerbOrdinal: 7,
      lines: [
        {
          end: cubic[3],
          provenance: { sourceVerbOrdinal: 7, endNumerator: 1, depth: 0 },
        },
      ],
    };
    expectStatus([[segment]], 'UNRESOLVED', undefined, { leaves: 2, pairs: 0 });
  });
});

describe('P3.1e validation, limits, and ownership', () => {
  it('rejects a one-step knot perturbation before hull work', () => {
    const fixture = fixtureById('C01/identity');
    const segment = fixture.contours[0]![0]!;
    const firstLine = segment.lines[0]!;
    const lines = [
      { ...firstLine, end: [nextUpPositive(firstLine.end[0]), firstLine.end[1]] as const },
      ...segment.lines.slice(1),
    ];
    expectStatus(replaceSegment(fixture, 0, 0, { ...segment, lines }), 'KNOT_MISMATCH', undefined, {
      leaves: 0,
      pairs: 0,
    });
  });

  it('rejects source, provenance coverage, and canonical-chain corruptions at zero counters', () => {
    const fixture = fixtureById('C01/identity');
    const segment = fixture.contours[0]![0]!;
    const second = fixture.contours[0]![1]!;
    const provenanceCorruptions: readonly (readonly ReferenceFlattenedLine[])[] = [
      segment.lines.slice(1),
      segment.lines.slice(0, -1),
      [segment.lines[0]!, segment.lines[0]!, ...segment.lines.slice(1)],
      [segment.lines[1]!, segment.lines[0]!, ...segment.lines.slice(2)],
    ];
    for (const lines of provenanceCorruptions)
      expectStatus(
        replaceSegment(fixture, 0, 0, { ...segment, lines }),
        'INVALID_PROVENANCE',
        undefined,
        { leaves: 0, pairs: 0 },
      );
    expectStatus(
      replaceSegment(fixture, 0, 0, { ...segment, sourceVerbOrdinal: 99 }),
      'INVALID_PROVENANCE',
      undefined,
      { leaves: 0, pairs: 0 },
    );
    expectStatus(
      replaceSegment(fixture, 0, 1, { ...second, sourceVerbOrdinal: segment.sourceVerbOrdinal }),
      'INVALID_INPUT',
      undefined,
      { leaves: 0, pairs: 0 },
    );
    const disconnected = [
      [123, 456],
      second.cubic[1],
      second.cubic[2],
      second.cubic[3],
    ] as const satisfies Cubic;
    expectStatus(
      replaceSegment(fixture, 0, 1, { ...second, cubic: disconnected }),
      'INVALID_INPUT',
      undefined,
      { leaves: 0, pairs: 0 },
    );
  });

  it('completes input and provenance preflight before reporting an earlier knot mismatch', () => {
    const fixture = fixtureById('C01/identity');
    const first = fixture.contours[0]![0]!;
    const last = fixture.contours[0]!.at(-1)!;
    const perturbedFirst = {
      ...first,
      lines: [
        {
          ...first.lines[0]!,
          end: [nextUpPositive(first.lines[0]!.end[0]), first.lines[0]!.end[1]] as const,
        },
        ...first.lines.slice(1),
      ],
    };
    const badLateProvenance = {
      ...last,
      lines: [
        ...last.lines.slice(0, -1),
        { ...last.lines.at(-1)!, provenance: null } as unknown as ReferenceFlattenedLine,
      ],
    };
    let contours = replaceSegment(fixture, 0, 0, perturbedFirst);
    contours = contours.map((contour, contourIndex) =>
      contourIndex === 0
        ? contour.map((segment, segmentIndex) =>
            segmentIndex === contour.length - 1 ? badLateProvenance : segment,
          )
        : contour,
    );
    expectStatus(contours, 'INVALID_PROVENANCE', undefined, { leaves: 0, pairs: 0 });

    const badEarlyProvenance = {
      ...first,
      lines: [
        {
          ...first.lines[0]!,
          provenance: { ...first.lines[0]!.provenance, sourceVerbOrdinal: 99 },
        },
        ...first.lines.slice(1),
      ],
    };
    const badLateInput = {
      ...last,
      lines: [...last.lines.slice(0, -1), { ...last.lines.at(-1)!, end: [Number.NaN, 0] as const }],
    };
    contours = replaceSegment(fixture, 0, 0, badEarlyProvenance);
    contours = contours.map((contour, contourIndex) =>
      contourIndex === 0
        ? contour.map((segment, segmentIndex) =>
            segmentIndex === contour.length - 1 ? badLateInput : segment,
          )
        : contour,
    );
    expectStatus(contours, 'INVALID_INPUT', undefined, { leaves: 0, pairs: 0 });
  });

  it('rejects nonfinite, malformed, and sparse later data without throwing', () => {
    const valid = fixtureById('C01/identity').contours;
    const sparseOuter = new Array<readonly CubicTopologySegmentFixture[]>(2);
    sparseOuter[0] = valid[0]!;
    const sparseContour = new Array<CubicTopologySegmentFixture>(2);
    sparseContour[0] = valid[0]![0]!;
    const sparseCubic = new Array(4);
    sparseCubic[0] = [0, 0];
    const malformed: unknown[] = [
      [],
      [[]],
      sparseOuter,
      [sparseContour],
      [[{ ...valid[0]![0], cubic: sparseCubic }]],
      [
        [
          {
            ...valid[0]![0],
            cubic: [
              [0, 0],
              [0, 0],
              [0, 0],
              [Number.NaN, 0],
            ],
          },
        ],
      ],
      [[{ ...valid[0]![0], lines: new Array(1) }]],
      [valid[0], [{ cubic: null, sourceVerbOrdinal: 100, lines: [] }]],
    ];
    for (const candidate of malformed)
      expect(() =>
        expectStatus(candidate as TopologyInput, 'INVALID_INPUT', undefined, {
          leaves: 0,
          pairs: 0,
        }),
      ).not.toThrow();
  });

  it('validates every limit before malformed input', () => {
    const invalid: TopologyLimits[] = [
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
      expectStatus([], 'INVALID_LIMITS', limits, {
        leaves: 0,
        pairs: 0,
      });
  });

  it('enforces inclusive contour, cubic, leaf, and pair ceilings with exact counters', () => {
    const c05 = fixtureById('C05/identity');
    expectStatus(
      c05.contours,
      'CERTIFIED',
      {
        maxContours: 4,
        maxCubics: 16,
        maxLeaves: 64,
        maxPairs: 2016,
      },
      { leaves: 64, pairs: 2016 },
    );
    expectStatus(c05.contours, 'WORK_LIMIT', { maxContours: 3 }, { leaves: 0, pairs: 0 });
    expectStatus(c05.contours, 'WORK_LIMIT', { maxCubics: 15 }, { leaves: 0, pairs: 0 });
    expectStatus(c05.contours, 'WORK_LIMIT', { maxLeaves: 63 }, { leaves: 0, pairs: 0 });
    expectStatus(c05.contours, 'WORK_LIMIT', { maxPairs: 2015 }, { leaves: 64, pairs: 2015 });

    const c01 = fixtureById('C01/identity');
    expectStatus(c01.contours, 'WORK_LIMIT', { maxPairs: 0 }, { leaves: 16, pairs: 0 });
    expectStatus(c01.contours, 'WORK_LIMIT', { maxPairs: 119 }, { leaves: 16, pairs: 119 });
    const c04 = fixtureById('C04/identity');
    expectStatus(c04.contours, 'WORK_LIMIT', { maxLeaves: 12 }, { leaves: 12, pairs: 0 });
  });

  it('checks the leaf cap before projection after an earlier implicit closure fills it', () => {
    const c04 = fixtureById('C04/identity');
    const negative = simpleCubicTopologyRejectingControls().find(
      ({ id }) => id === 'negative-projection',
    )!.contours[0]![0]!;
    const sourceVerbOrdinal = 100;
    const reordinaled = {
      ...negative,
      sourceVerbOrdinal,
      lines: negative.lines.map((line) => ({
        ...line,
        provenance: { ...line.provenance, sourceVerbOrdinal },
      })),
    };
    expectStatus(
      [...c04.contours, [reordinaled]],
      'WORK_LIMIT',
      { maxLeaves: 13 },
      {
        leaves: 13,
        pairs: 0,
      },
    );
  });

  it('checks excess counts before malformed excess content', () => {
    const c05 = fixtureById('C05/identity');
    const malformedSegment = { cubic: null, sourceVerbOrdinal: -1, lines: new Array(100) };
    expectStatus(
      [...c05.contours, [malformedSegment]] as unknown as TopologyInput,
      'WORK_LIMIT',
      undefined,
      { leaves: 0, pairs: 0 },
    );
    expectStatus(
      [[...c05.contours.flat(), malformedSegment]] as unknown as TopologyInput,
      'WORK_LIMIT',
      undefined,
      { leaves: 0, pairs: 0 },
    );
    const last = c05.contours.at(-1)!.at(-1)!;
    const excessLines = [...last.lines, ...(new Array(1) as ReferenceFlattenedLine[])];
    expectStatus(
      replaceSegment(c05, 3, 3, { ...last, lines: excessLines }),
      'WORK_LIMIT',
      { maxLeaves: 64 },
      { leaves: 0, pairs: 0 },
    );
  });

  it('is deterministic, immutable, and never publishes a partial certificate', () => {
    const fixture = fixtureById('C06/identity');
    const before = structuredClone(fixture.contours);
    const first = certifySimpleCubicTopology(fixture.contours);
    const second = certifySimpleCubicTopology(fixture.contours);
    expect(first).toEqual(second);
    expect(fixture.contours).toEqual(before);

    for (const control of simpleCubicTopologyRejectingControls()) {
      const result = certifySimpleCubicTopology(control.contours);
      expect(result.ok).toBe(false);
      expect(result.certificate).toBeNull();
    }
  });

  it('returns certificate point tuples owned independently from caller arrays', () => {
    const contours = structuredClone(fixtureById('C01/identity').contours) as unknown as Array<
      Array<{
        cubic: Array<[number, number]>;
        sourceVerbOrdinal: number;
        lines: Array<{ end: [number, number]; provenance: ReferenceFlattenedLine['provenance'] }>;
      }>
    >;
    const result = certifySimpleCubicTopology(contours as unknown as TopologyInput);
    expect(result.status).toBe('CERTIFIED');
    const snapshot = structuredClone(result.certificate);
    contours[0]![0]!.cubic[0]![0] = 999;
    contours[0]![0]!.lines[0]!.end[0] = 999;
    expect(result.certificate).toEqual(snapshot);
  });
});
