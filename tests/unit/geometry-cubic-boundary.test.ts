import { describe, expect, it } from 'vitest';
import type {
  Cubic,
  Matrix2,
  ReferenceFlattenedLine,
} from '../../packages/geometry-reference/src/types.js';
import { compare, rational } from '../geometry/rounded-fill/exact.js';
import { certifyCubicBoundary, decodeBoundaryNumber } from '../geometry/cubic-boundary/oracle.js';
import { fixedCubicBoundaryFixtures } from '../geometry/cubic-boundary/fixtures.js';

const I = [1, 0, 0, 1] as const satisfies Matrix2;
const Z = [0, 0, 0, 0] as const satisfies Matrix2;
const SOURCE = 7;
const ZERO_CUBIC = [
  [0, 0],
  [0, 0],
  [0, 0],
  [0, 0],
] as const satisfies Cubic;
const LINEAR = [
  [0, 0],
  [1, 1],
  [2, 2],
  [3, 3],
] as const satisfies Cubic;
const ARCH = [
  [0, 0],
  [1, 1 / 8],
  [2, 1 / 8],
  [3, 0],
] as const satisfies Cubic;
const DOUBLE_ARCH = [
  [0, 0],
  [1, 1 / 4],
  [2, 1 / 4],
  [3, 0],
] as const satisfies Cubic;
const INFLECTION_REFINEMENT = [
  [0, 0],
  [1, 1 / 4],
  [2, -1 / 4],
  [3, 0],
] as const satisfies Cubic;

type BoundaryInput = Parameters<typeof certifyCubicBoundary>[0];
type BoundaryLimits = Parameters<typeof certifyCubicBoundary>[1];

function line(
  end: readonly [number, number],
  endNumerator = 1,
  depth = 0,
  sourceVerbOrdinal = SOURCE,
): ReferenceFlattenedLine {
  return { end, provenance: { sourceVerbOrdinal, endNumerator, depth } };
}

function input(
  cubic: Cubic,
  lines: readonly ReferenceFlattenedLine[],
  screen: Matrix2 = I,
  sourceVerbOrdinal = SOURCE,
): BoundaryInput {
  return { cubic, lines, screen, sourceVerbOrdinal };
}

function expectStatus(
  value: BoundaryInput,
  status: string,
  limits?: BoundaryLimits,
  cells?: number,
) {
  const result = certifyCubicBoundary(value, limits);
  expect(result.status).toBe(status);
  expect(result.ok).toBe(status === 'CERTIFIED');
  if (cells !== undefined) expect(result.cells).toBe(cells);
  if (status === 'CERTIFIED') expect(result.maxCertifiedSquared).not.toBeNull();
  else expect(result.maxCertifiedSquared).toBeNull();
  expect(result.finding === null).toBe(status === 'CERTIFIED');
  return result;
}

describe('P3.1d frozen cubic boundary fixtures', () => {
  it('freezes all 106 cases, their family counts, order, profiles, and densities', () => {
    const fixtures = fixedCubicBoundaryFixtures();
    expect(fixtures).toHaveLength(106);
    expect(fixtures.slice(0, 56).every(({ id }) => id.startsWith('named/'))).toBe(true);
    expect(fixtures.slice(56, 72).every(({ id }) => id.startsWith('seeded/'))).toBe(true);
    expect(fixtures.slice(72, 104).every(({ id }) => id.startsWith('metamorphic/'))).toBe(true);
    expect(fixtures.slice(104).map(({ id }) => id)).toEqual([
      'subdivision/arch/left',
      'subdivision/arch/right',
    ]);

    const namedProfiles = ['I', 'R16', 'D32', 'S192', 'Z01', 'Q', 'Z'];
    const namedDepths = [6, 8, 8, 10, 6, 6, 6];
    for (let index = 0; index < 56; index += 1) {
      const fixture = fixtures[index]!;
      const profileIndex = index % namedProfiles.length;
      expect(fixture.id.endsWith(`/${namedProfiles[profileIndex]}`)).toBe(true);
      expect(fixture.depth).toBe(namedDepths[profileIndex]);
      expect(fixture.lines).toHaveLength(2 ** namedDepths[profileIndex]!);
    }
    for (let index = 56; index < 72; index += 1) {
      const fixture = fixtures[index]!;
      const profileIndex = (index - 56) % 4;
      expect(fixture.id.endsWith(`/${namedProfiles[profileIndex]}`)).toBe(true);
      expect(fixture.depth).toBe(namedDepths[profileIndex]);
      expect(fixture.lines).toHaveLength(2 ** namedDepths[profileIndex]!);
    }
    expect(fixtures.slice(72).every(({ depth, lines }) => depth === 6 && lines.length === 64)).toBe(
      true,
    );
    expect(fixtures.reduce((sum, { lines }) => sum + lines.length, 0)).toBe(22_912);
    expect(fixtures.every(({ sourceVerbOrdinal }) => sourceVerbOrdinal === SOURCE)).toBe(true);
  });

  it('certifies every frozen baseline without native output or supplied expectations', () => {
    for (const fixture of fixedCubicBoundaryFixtures()) {
      const result = certifyCubicBoundary(fixture);
      expect(result.status, fixture.id).toBe('CERTIFIED');
      expect(result.ok, fixture.id).toBe(true);
      expect(result.finding, fixture.id).toBeNull();
      expect(result.maxCertifiedSquared, fixture.id).not.toBeNull();
    }
  });
});

describe('P3.1d exact literal controls', () => {
  it('decodes binary64 scalars into ordinary rational units', () => {
    expect(decodeBoundaryNumber(1)).toEqual(rational(1n));
    expect(decodeBoundaryNumber(Number.MIN_VALUE)).toEqual(rational(1n, 1n << 1074n));
    expect(decodeBoundaryNumber(Number.MAX_VALUE)).toEqual(rational((2n ** 53n - 1n) * 2n ** 971n));
    expect(decodeBoundaryNumber(-0)).toEqual(rational(0n));
    expect(() => decodeBoundaryNumber(Number.NaN)).toThrow();
    expect(() => decodeBoundaryNumber(Number.POSITIVE_INFINITY)).toThrow();
  });

  it('certifies the exact 3/32 quadratic-arch maximum', () => {
    const result = expectStatus(input(ARCH, [line([3, 0])]), 'CERTIFIED', undefined, 1);
    expect(result.maxCertifiedSquared).not.toBeNull();
    expect(compare(result.maxCertifiedSquared!, rational(9n, 1024n))).toBe(0);
  });

  it('distinguishes a midpoint witness from finite depth exhaustion', () => {
    expectStatus(input(DOUBLE_ARCH, [line([3, 0])]), 'PHYSICAL_ERROR');
    expectStatus(input(DOUBLE_ARCH, [line([3, 0])]), 'UNRESOLVED', { maxDepth: 0 }, 1);
  });

  it('certifies a sub-target inflection only after exact refinement', () => {
    expectStatus(
      input(INFLECTION_REFINEMENT, [line([3, 0])]),
      'CERTIFIED',
      { maxDepth: 2, maxCells: 7 },
      7,
    );
    expectStatus(input(INFLECTION_REFINEMENT, [line([3, 0])]), 'UNRESOLVED', { maxDepth: 1 }, 2);
    expectStatus(
      input(INFLECTION_REFINEMENT, [line([3, 0])]),
      'WORK_LIMIT',
      { maxDepth: 2, maxCells: 6 },
      6,
    );
  });

  it('accepts exact subnormal and maximum finite constants', () => {
    for (const value of [Number.MIN_VALUE, Number.MAX_VALUE]) {
      const cubic = [
        [value, -value],
        [value, -value],
        [value, -value],
        [value, -value],
      ] as const satisfies Cubic;
      const result = expectStatus(
        input(cubic, [line([value, -value])], [192, 96, 0, 192]),
        'CERTIFIED',
        undefined,
        1,
      );
      expect(result.maxCertifiedSquared).toEqual(rational(0n));
    }
  });

  it('preserves a nonzero exact product across subnormal and maximum finite units', () => {
    const result = expectStatus(
      input(ZERO_CUBIC, [line([Number.MIN_VALUE, 0])], [Number.MAX_VALUE, 0, 0, 0]),
      'CERTIFIED',
      undefined,
      1,
    );
    expect(result.maxCertifiedSquared).toEqual(rational((2n ** 53n - 1n) ** 2n, 2n ** 206n));
  });

  it('accepts complete mixed-depth dyadic coverage with zero bound', () => {
    const result = expectStatus(
      input(LINEAR, [
        line([3 / 2, 3 / 2], 1, 1),
        line([9 / 4, 9 / 4], 3, 2),
        line([21 / 8, 21 / 8], 7, 3),
        line([3, 3], 8, 3),
      ]),
      'CERTIFIED',
      undefined,
      4,
    );
    expect(result.maxCertifiedSquared).toEqual(rational(0n));
  });

  it('keeps the local and physical 1/8 boundaries inclusive', () => {
    const displacement = 2 ** -45;
    expectStatus(input(ZERO_CUBIC, [line([displacement, 0])], Z), 'CERTIFIED', undefined, 1);
    expectStatus(
      input(ZERO_CUBIC, [line([displacement, 0])], [2 ** 42, 0, 0, 0]),
      'CERTIFIED',
      undefined,
      1,
    );
    expectStatus(
      input(ZERO_CUBIC, [line([displacement, 0])], [2 ** 43, 0, 0, 0]),
      'PHYSICAL_ERROR',
      undefined,
      1,
    );
    expectStatus(
      input(ZERO_CUBIC, [line([2 ** -45 + 2 ** -97, 0])], Z),
      'LOCAL_KNOT_ERROR',
      undefined,
      0,
    );
  });

  it('drops an earlier certificate when a later cell has a physical witness', () => {
    const result = expectStatus(
      input(ZERO_CUBIC, [line([0, 0], 1, 1), line([2 ** -45, 0], 2, 1)], [2 ** 43, 0, 0, 0]),
      'PHYSICAL_ERROR',
      undefined,
      2,
    );
    expect(result.maxCertifiedSquared).toBeNull();
  });
});

describe('P3.1d provenance and shape rejection', () => {
  const mixed = [
    line([3 / 2, 3 / 2], 1, 1),
    line([9 / 4, 9 / 4], 3, 2),
    line([21 / 8, 21 / 8], 7, 3),
    line([3, 3], 8, 3),
  ] as const;

  it('rejects missing, duplicate, reordered, wrong-source, and malformed intervals', () => {
    const corruptions: readonly (readonly ReferenceFlattenedLine[])[] = [
      mixed.slice(1),
      mixed.slice(0, -1),
      [mixed[0], mixed[0], ...mixed.slice(1)],
      [mixed[1], mixed[0], ...mixed.slice(2)],
      [line([3 / 2, 3 / 2], 1, 1, 8), ...mixed.slice(1)],
      [line([3, 3], 0, 0)],
      [line([3, 3], 2, 0)],
      [line([3, 3], 1, -1)],
      [line([3, 3], 1, 21)],
    ];
    for (const lines of corruptions)
      expectStatus(input(LINEAR, lines), 'INVALID_PROVENANCE', undefined, 0);
  });

  it('rejects local endpoint displacement even in a screen nullspace', () => {
    expectStatus(input(ZERO_CUBIC, [line([1, 0])], Z), 'LOCAL_KNOT_ERROR', undefined, 0);
    expectStatus(input(ZERO_CUBIC, [line([0, 1])], [1, 0, 0, 0]), 'LOCAL_KNOT_ERROR', undefined, 0);
  });

  it('rejects nonfinite and malformed input tuples without throwing', () => {
    const sparsePoint = new Array<number>(2);
    sparsePoint[0] = 0;
    const malformed: unknown[] = [
      input(
        [
          [0, 0],
          [0, 0],
          [0, 0],
          [Number.NaN, 0],
        ],
        [line([0, 0])],
      ),
      input(ZERO_CUBIC, [line([Number.POSITIVE_INFINITY, 0])]),
      input(ZERO_CUBIC, [line([0, 0])], [1, 0, 0, Number.NEGATIVE_INFINITY]),
      { cubic: new Array(4), lines: [line([0, 0])], screen: I, sourceVerbOrdinal: SOURCE },
      { cubic: ZERO_CUBIC, lines: [line([0, 0])], screen: new Array(4), sourceVerbOrdinal: SOURCE },
      {
        cubic: [[0, 0], [0, 0], [0, 0], sparsePoint],
        lines: [line([0, 0])],
        screen: I,
        sourceVerbOrdinal: SOURCE,
      },
      { cubic: ZERO_CUBIC, lines: new Array(1), screen: I, sourceVerbOrdinal: SOURCE },
    ];
    for (const value of malformed)
      expect(() =>
        expectStatus(value as BoundaryInput, 'INVALID_INPUT', undefined, 0),
      ).not.toThrow();
  });

  it('rejects malformed provenance objects before continuous work', () => {
    const malformed: unknown[] = [
      { end: [0, 0], provenance: null },
      { end: [0, 0], provenance: {} },
      { end: [0, 0], provenance: { sourceVerbOrdinal: SOURCE, endNumerator: 1 } },
      { end: [0, 0], provenance: new Array(3) },
    ];
    for (const candidate of malformed) {
      const value = input(ZERO_CUBIC, [candidate as ReferenceFlattenedLine]);
      expect(() => expectStatus(value, 'INVALID_PROVENANCE', undefined, 0)).not.toThrow();
    }
  });

  it('enforces source ordinal and line cardinality', () => {
    expectStatus(input(ZERO_CUBIC, [line([0, 0], 1, 0, 0xffffffff)], I, 0xffffffff), 'CERTIFIED');
    expectStatus(
      input(ZERO_CUBIC, [line([0, 0])], I, 0x1_0000_0000),
      'INVALID_INPUT',
      undefined,
      0,
    );
    expectStatus(input(ZERO_CUBIC, []), 'INVALID_INPUT', undefined, 0);
    expectStatus(input(ZERO_CUBIC, [line([0, 0]), line([0, 0])]), 'WORK_LIMIT', { maxLines: 1 }, 0);
    const maximumLines = Array.from({ length: 8192 }, (_, index) => line([0, 0], index + 1, 13));
    expectStatus(input(ZERO_CUBIC, maximumLines), 'CERTIFIED', undefined, 8192);
    expectStatus(
      {
        cubic: new Array(4),
        lines: new Array(8193),
        screen: new Array(4),
        sourceVerbOrdinal: -1,
      } as unknown as BoundaryInput,
      'WORK_LIMIT',
      undefined,
      0,
    );
  });
});

describe('P3.1d limits, precedence, determinism, and atomicity', () => {
  it('validates every limit field before input', () => {
    const invalidLimits: BoundaryLimits[] = [
      { maxLines: 0 },
      { maxLines: 8193 },
      { maxDepth: -1 },
      { maxDepth: 25 },
      { maxCells: 0 },
      { maxCells: 1_048_577 },
      { maxLines: 1.5 },
      { maxDepth: Number.NaN },
      { maxCells: Number.POSITIVE_INFINITY },
    ];
    const invalidInput = {
      cubic: [],
      lines: [],
      screen: [],
      sourceVerbOrdinal: -1,
    } as unknown as BoundaryInput;
    for (const limits of invalidLimits) expectStatus(invalidInput, 'INVALID_LIMITS', limits, 0);
  });

  it('accepts smaller limits at their boundary and rejects the first exceedance', () => {
    expectStatus(
      input(ZERO_CUBIC, [line([0, 0])]),
      'CERTIFIED',
      {
        maxLines: 1,
        maxDepth: 0,
        maxCells: 1,
      },
      1,
    );
    expectStatus(input(DOUBLE_ARCH, [line([3, 0])]), 'WORK_LIMIT', { maxCells: 1 }, 1);
    expectStatus(input(DOUBLE_ARCH, [line([3, 0])]), 'UNRESOLVED', { maxDepth: 0 }, 1);
    expectStatus(input(ZERO_CUBIC, [line([0, 0])]), 'CERTIFIED', {
      maxLines: 8192,
      maxDepth: 24,
      maxCells: 1_048_576,
    });
  });

  it('applies the cell cap before reaching a later physical witness', () => {
    expectStatus(
      input(ZERO_CUBIC, [line([0, 0], 1, 1), line([2 ** -45, 0], 2, 1)], [2 ** 43, 0, 0, 0]),
      'WORK_LIMIT',
      { maxCells: 1 },
      1,
    );
  });

  it('applies input, provenance, and all-knot precedence before continuous work', () => {
    expectStatus(
      input(
        [
          [0, 0],
          [0, 0],
          [0, 0],
          [Number.NaN, 0],
        ],
        [line([1, 0], 2, 0)],
      ),
      'INVALID_INPUT',
      undefined,
      0,
    );
    expectStatus(input(ZERO_CUBIC, [line([1, 0], 1, 0, 8)], Z), 'INVALID_PROVENANCE', undefined, 0);
    expectStatus(
      input(
        ZERO_CUBIC,
        [line([2 ** -45, 0], 1, 1), line([2 ** -45 + 2 ** -97, 0], 2, 1)],
        [2 ** 43, 0, 0, 0],
      ),
      'LOCAL_KNOT_ERROR',
      undefined,
      0,
    );
  });

  it('is deterministic, stateless, and leaves all input arrays unchanged', () => {
    const value = input(ARCH, [line([3, 0])]);
    const before = structuredClone(value);
    const first = certifyCubicBoundary(value);
    const second = certifyCubicBoundary(value);
    expect(first).toEqual(second);
    expect(value).toEqual(before);
  });

  it('publishes no certificate for every failure status', () => {
    const failures = [
      certifyCubicBoundary(input(ZERO_CUBIC, [line([0, 0])]), { maxCells: 0 }),
      certifyCubicBoundary(input(ZERO_CUBIC, [])),
      certifyCubicBoundary(input(ZERO_CUBIC, [line([0, 0], 2, 0)])),
      certifyCubicBoundary(input(ZERO_CUBIC, [line([1, 0])], Z)),
      certifyCubicBoundary(input(ZERO_CUBIC, [line([2 ** -45, 0])], [2 ** 43, 0, 0, 0])),
      certifyCubicBoundary(input(DOUBLE_ARCH, [line([3, 0])]), { maxDepth: 0 }),
      certifyCubicBoundary(input(DOUBLE_ARCH, [line([3, 0])]), { maxCells: 1 }),
    ];
    expect(failures.map(({ status }) => status)).toEqual([
      'INVALID_LIMITS',
      'INVALID_INPUT',
      'INVALID_PROVENANCE',
      'LOCAL_KNOT_ERROR',
      'PHYSICAL_ERROR',
      'UNRESOLVED',
      'WORK_LIMIT',
    ]);
    expect(
      failures.every(
        ({ ok, finding, maxCertifiedSquared }) =>
          !ok && finding !== null && maxCertifiedSquared === null,
      ),
    ).toBe(true);
  });
});
