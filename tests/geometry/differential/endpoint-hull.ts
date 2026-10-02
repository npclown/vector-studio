import type {
  CanonicalPackedInput,
  Cubic,
  Point,
} from '../../../packages/geometry-reference/src/index.js';

export type EndpointHullPathExpectation = Readonly<{
  status: 0 | 4;
  cubics: readonly Readonly<{ cubic: Cubic; sourceVerbOrdinal: number }>[];
}>;

export type EndpointHullFixture = Readonly<{
  id: `E${string}` | `F${string}`;
  input: CanonicalPackedInput;
  paths: readonly EndpointHullPathExpectation[];
  metadata: Readonly<{
    expectedStatuses: readonly (0 | 4)[];
    pointBits: readonly (readonly string[])[];
    toleranceBits: readonly string[];
  }>;
}>;

export type EndpointHullFixtureMetadata = Readonly<{
  id: EndpointHullFixture['id'];
  expectedStatuses: readonly (0 | 4)[];
  pointBits: readonly (readonly string[])[];
  toleranceBits: readonly string[];
}>;

const view = new DataView(new ArrayBuffer(8));

function numberFromBits(bits: string): number {
  if (!/^[0-9a-f]{16}$/u.test(bits)) throw new Error(`invalid Float64 bits ${bits}`);
  view.setBigUint64(0, BigInt(`0x${bits}`), false);
  return view.getFloat64(0, false);
}

function bitsOf(value: number): string {
  view.setFloat64(0, value, false);
  return view.getBigUint64(0, false).toString(16).padStart(16, '0');
}

const T: Cubic = [
  [1, 0],
  [numberFromBits('3ff5555555555555'), 0],
  [numberFromBits('3ffaaaaaaaaaaaaa'), 0],
  [2, 0],
];

type SourcePath = Readonly<{
  verbs: readonly number[];
  points: readonly number[];
  tolerance: number;
  status: 0 | 4;
  cubics?: readonly Readonly<{ cubic: Cubic; sourceVerbOrdinal: number }>[];
}>;

function cubicPath(cubic: Cubic, status: 0 | 4, tolerance = 0.25): SourcePath {
  return {
    verbs: [0, 2],
    points: cubic.flat(),
    tolerance,
    status,
    cubics: status === 0 ? [{ cubic, sourceVerbOrdinal: 1 }] : [],
  };
}

function packed(paths: readonly SourcePath[]): CanonicalPackedInput {
  const requests = paths.map((path, index) => ({
    requestId: index + 1,
    sourceEpoch: 1,
    sourceRevision: 1,
    bucketTolerance: path.tolerance,
  }));
  const verbs: number[] = [];
  const points: number[] = [];
  const pathOffsets = [0];
  const pointOffsets = [0];
  for (const path of paths) {
    verbs.push(...path.verbs);
    points.push(...path.points);
    pathOffsets.push(verbs.length);
    pointOffsets.push(points.length);
  }
  return { requests, pathOffsets, pointOffsets, verbs, points };
}

function fixture(id: EndpointHullFixture['id'], paths: readonly SourcePath[]): EndpointHullFixture {
  const input = packed(paths);
  return {
    id,
    input,
    paths: paths.map((path) => ({ status: path.status, cubics: path.cubics ?? [] })),
    metadata: {
      expectedStatuses: paths.map(({ status }) => status),
      pointBits: paths.map(({ points }) => points.map(bitsOf)),
      toleranceBits: paths.map(({ tolerance }) => bitsOf(tolerance)),
    },
  };
}

const success = (id: EndpointHullFixture['id'], cubic: Cubic): EndpointHullFixture =>
  fixture(id, [cubicPath(cubic, 0)]);

function transformedPoint([x, y]: Point, transform: 'reflect' | 'translate' | 'swap'): Point {
  if (transform === 'reflect') return [-x, y];
  if (transform === 'translate') return [x + 8, y];
  return [y, x];
}

/** Returns the frozen E01-E10/F01-F04 endpoint-hull differential additions. */
export function endpointHullFixtures(): readonly EndpointHullFixture[] {
  const e02: Cubic = [
    [1, 0],
    [numberFromBits('3fe5555555555556'), 0],
    [numberFromBits('3fd5555555555556'), 0],
    [0, 0],
  ];
  const e03: Cubic = [
    transformedPoint(T[0], 'reflect'),
    transformedPoint(T[1], 'reflect'),
    transformedPoint(T[2], 'reflect'),
    transformedPoint(T[3], 'reflect'),
  ];
  const e04: Cubic = [
    transformedPoint(T[0], 'translate'),
    transformedPoint(T[1], 'translate'),
    transformedPoint(T[2], 'translate'),
    transformedPoint(T[3], 'translate'),
  ];
  const e05: Cubic = [
    transformedPoint(T[0], 'swap'),
    transformedPoint(T[1], 'swap'),
    transformedPoint(T[2], 'swap'),
    transformedPoint(T[3], 'swap'),
  ];
  const e06: Cubic = [
    [T[0][0], -0],
    [T[1][0], 0],
    [T[2][0], -0],
    [T[3][0], 0],
  ];
  const e07: Cubic = [
    [0, 0],
    [3, 0],
    [1, 0],
    [4, 0],
  ];
  const e08: Cubic = [
    [T[0][0], 0],
    [T[1][0], 3],
    [T[2][0], 3],
    [T[3][0], 0],
  ];
  const e09: Cubic = [
    [0, 0],
    [1 / 16, 0],
    [-1 / 8, 0],
    [7 / 16, 0],
  ];
  const e10: Cubic = [
    [0, 0],
    [0, 0],
    [1, 0],
    [1, 0],
  ];
  const f01: Cubic = [
    [Number.MAX_VALUE, 0],
    [-Number.MAX_VALUE, 0],
    [Number.MAX_VALUE, 0],
    [-Number.MAX_VALUE, 0],
  ];
  const f02: Cubic = [
    [0, 0],
    [numberFromBits('7fd8000000000000'), 0],
    [numberFromBits('7fd8000000000000'), 0],
    [numberFromBits('7fd8000000000000'), 0],
  ];
  const validNeighbor = cubicPath(T, 0);
  const f04Failure: SourcePath = {
    verbs: [0, 1, 0, 2],
    points: [
      0,
      0,
      1,
      0,
      Number.MAX_VALUE,
      0,
      -Number.MAX_VALUE,
      0,
      Number.MAX_VALUE,
      0,
      -Number.MAX_VALUE,
      0,
    ],
    tolerance: 0.25,
    status: 4,
    cubics: [],
  };
  return [
    success('E01', T),
    success('E02', e02),
    success('E03', e03),
    success('E04', e04),
    success('E05', e05),
    success('E06', e06),
    success('E07', e07),
    success('E08', e08),
    success('E09', e09),
    success('E10', e10),
    fixture('F01', [cubicPath(f01, 4), validNeighbor]),
    fixture('F02', [cubicPath(f02, 4, 2 ** 1000), validNeighbor]),
    fixture('F03', [cubicPath(T, 4, 2 ** -50), validNeighbor]),
    fixture('F04', [f04Failure, validNeighbor]),
  ];
}

/** Exposes only stable identities, statuses and encoded scalar bits to composition tests. */
export function endpointHullFixtureMetadata(): readonly EndpointHullFixtureMetadata[] {
  return endpointHullFixtures().map(({ id, metadata }) => ({ id, ...metadata }));
}
