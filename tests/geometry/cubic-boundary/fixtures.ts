import type {
  Cubic,
  Matrix2,
  Point,
  ReferenceFlattenedLine,
} from '../../../packages/geometry-reference/src/types.js';

export type CubicBoundaryFixture = Readonly<{
  id: string;
  cubic: Cubic;
  screen: Matrix2;
  depth: number;
  sourceVerbOrdinal: number;
  lines: readonly ReferenceFlattenedLine[];
}>;

const SOURCE_VERB_ORDINAL = 7;
const CONTROL_SCALE_POWER = 10;
const CONTROL_SCALE = 2 ** CONTROL_SCALE_POWER;

const NAMED_CUBICS = [
  [
    'constant',
    [
      [2, 3],
      [2, 3],
      [2, 3],
      [2, 3],
    ],
  ],
  [
    'linear',
    [
      [0, 0],
      [1, 1],
      [2, 2],
      [3, 3],
    ],
  ],
  [
    'arch',
    [
      [0, 0],
      [0, 4],
      [4, 4],
      [4, 0],
    ],
  ],
  [
    'inflection',
    [
      [0, 0],
      [0, 4],
      [4, -4],
      [4, 0],
    ],
  ],
  [
    'closed-loop',
    [
      [0, 0],
      [4, 4],
      [-4, 4],
      [0, 0],
    ],
  ],
  [
    'collinear-retrace',
    [
      [0, 0],
      [8, 0],
      [-8, 0],
      [0, 0],
    ],
  ],
  [
    'stationary',
    [
      [0, 0],
      [4, 0],
      [0, 0],
      [4, 0],
    ],
  ],
  [
    'asymmetric',
    [
      [-3, 2],
      [5, -4],
      [-6, 7],
      [2, -1],
    ],
  ],
] as const satisfies readonly (readonly [string, Cubic])[];

const PROFILES = [
  ['I', [1, 0, 0, 1], 6],
  ['R16', [0, -16, 16, 0], 8],
  ['D32', [32, 0, 0, 1 / 32], 8],
  ['S192', [192, 96, 0, 192], 10],
  ['Z01', [0.01, 0, 0, 0.01], 6],
  ['Q', [1, 2, 0, 0], 6],
  ['Z', [0, 0, 0, 0], 6],
] as const satisfies readonly (readonly [string, Matrix2, number])[];

function required<T>(value: T | undefined, label: string): T {
  if (value === undefined) throw new Error(label);
  return value;
}

/** Converts the reviewed fixture dyadic whose numerator is exactly representable in binary64. */
function boundedDyadicToNumber(numerator: bigint, denominatorPower: number): number {
  const magnitude = numerator < 0n ? -numerator : numerator;
  if (magnitude > BigInt(Number.MAX_SAFE_INTEGER))
    throw new Error('fixture dyadic numerator escaped its reviewed exact-integer bound');
  const value = Number(numerator) * 2 ** -denominatorPower;
  if (!Number.isFinite(value) || Math.abs(value) > 2 ** 21)
    throw new Error('fixture dyadic escaped its reviewed finite coordinate bound');
  return value;
}

function controlNumerator(value: number): bigint {
  const scaled = value * CONTROL_SCALE;
  if (!Number.isSafeInteger(scaled))
    throw new Error('fixture control is outside the reviewed 1/1024 dyadic grid');
  return BigInt(scaled);
}

/** Direct cubic Bernstein evaluation over integers and a power-of-two denominator. */
function exactBernsteinCoordinate(
  controls: readonly [number, number, number, number],
  endNumerator: number,
  depth: number,
): number {
  const denominator = 1n << BigInt(depth);
  const t = BigInt(endNumerator);
  const oneMinusT = denominator - t;
  const [p0, p1, p2, p3] = controls.map(controlNumerator) as [bigint, bigint, bigint, bigint];
  const numerator =
    p0 * oneMinusT * oneMinusT * oneMinusT +
    3n * p1 * oneMinusT * oneMinusT * t +
    3n * p2 * oneMinusT * t * t +
    p3 * t * t * t;
  return boundedDyadicToNumber(numerator, CONTROL_SCALE_POWER + 3 * depth);
}

function uniformLines(cubic: Cubic, depth: number): readonly ReferenceFlattenedLine[] {
  const count = 2 ** depth;
  const xs = cubic.map(([x]) => x) as [number, number, number, number];
  const ys = cubic.map(([, y]) => y) as [number, number, number, number];
  return Array.from({ length: count }, (_, index) => {
    const endNumerator = index + 1;
    return {
      end: [
        exactBernsteinCoordinate(xs, endNumerator, depth),
        exactBernsteinCoordinate(ys, endNumerator, depth),
      ],
      provenance: { sourceVerbOrdinal: SOURCE_VERB_ORDINAL, endNumerator, depth },
    };
  });
}

function fixture(id: string, cubic: Cubic, screen: Matrix2, depth: number): CubicBoundaryFixture {
  return {
    id,
    cubic,
    screen,
    depth,
    sourceVerbOrdinal: SOURCE_VERB_ORDINAL,
    lines: uniformLines(cubic, depth),
  };
}

function seededCubics(): readonly Cubic[] {
  let state = 0x50333144;
  const next = (): number => {
    state = (state ^ (state << 13)) >>> 0;
    state = (state ^ (state >>> 17)) >>> 0;
    state = (state ^ (state << 5)) >>> 0;
    return state;
  };
  return Array.from({ length: 16 }, () =>
    Array.from({ length: 4 }, () => [(next() % 17) - 8, (next() % 17) - 8] as const),
  ) as unknown as Cubic[];
}

function mapCubic(cubic: Cubic, transform: (point: Point) => Point): Cubic {
  return cubic.map(transform) as unknown as Cubic;
}

const ARCH_HALVES = [
  [
    [0, 0],
    [0, 2],
    [1, 3],
    [2, 3],
  ],
  [
    [2, 3],
    [3, 3],
    [4, 2],
    [4, 0],
  ],
] as const satisfies readonly [Cubic, Cubic];

/** Returns the frozen 106-case P3.1d fixture corpus in contract order. */
export function fixedCubicBoundaryFixtures(): readonly CubicBoundaryFixture[] {
  const fixtures: CubicBoundaryFixture[] = [];
  for (const [name, cubic] of NAMED_CUBICS) {
    for (const [profile, screen, depth] of PROFILES)
      fixtures.push(fixture(`named/${name}/${profile}`, cubic, screen, depth));
  }

  const seededProfiles = PROFILES.slice(0, 4);
  seededCubics().forEach((cubic, index) => {
    const [profile, screen, depth] = required(
      seededProfiles[index % seededProfiles.length],
      'seeded profile',
    );
    fixtures.push(
      fixture(`seeded/${String(index).padStart(2, '0')}/${profile}`, cubic, screen, depth),
    );
  });

  const identity = required(PROFILES[0], 'identity profile')[1];
  for (const [name, cubic] of NAMED_CUBICS) {
    fixtures.push(
      fixture(`metamorphic/${name}/reverse`, [...cubic].reverse() as unknown as Cubic, identity, 6),
    );
    fixtures.push(
      fixture(
        `metamorphic/${name}/translate`,
        mapCubic(cubic, ([x, y]) => [x + 2 ** 20, y - 2 ** 20]),
        identity,
        6,
      ),
    );
    fixtures.push(
      fixture(
        `metamorphic/${name}/reflect`,
        mapCubic(cubic, ([x, y]) => [-x, y]),
        identity,
        6,
      ),
    );
    fixtures.push(
      fixture(
        `metamorphic/${name}/scale`,
        mapCubic(cubic, ([x, y]) => [x / 1024, y / 1024]),
        identity,
        6,
      ),
    );
  }

  fixtures.push(fixture('subdivision/arch/left', ARCH_HALVES[0], identity, 6));
  fixtures.push(fixture('subdivision/arch/right', ARCH_HALVES[1], identity, 6));
  return fixtures;
}
