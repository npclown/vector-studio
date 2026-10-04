import type { Point } from '../../../packages/geometry-reference/src/types.js';
import { fixedNativeDepthPositiveCubicFixtureRows } from '../native-depth-positive-cubic/fixtures.js';
import { fixedNativeMixedCubicFixtureRows } from '../native-mixed-cubic/fixtures.js';
import { fixedNativeTriangleFreeCubicFixtureRows } from '../native-triangle-free-cubic/fixtures.js';
import { bitsOf } from '../rounded-fill/exact.js';
import { buildRoundedFillOracle } from '../rounded-fill/oracle.js';
import type { ExpectedCarrier, FixtureRow } from '../rounded-fill/types.js';

export type PlainMesh = Readonly<{
  vertices: readonly Point[];
  indices: readonly number[];
}>;

export type ConformingMeshFixture = Readonly<{
  id: string;
  mesh: PlainMesh;
  expectedParentCounts: readonly number[];
  expectedTriangleCount: number;
  expectedTwiceArea: bigint;
  expectedIndices?: readonly number[];
  expectedParents?: readonly number[];
}>;

export type CarrierConformingMeshFixture = ConformingMeshFixture &
  Readonly<{
    carrier: ExpectedCarrier;
  }>;

const UNIT_SQUARED = 1n << 2148n;

/** Returns the seven contract-literal analytic source meshes. */
export function fixedConformingMeshFixtures(): readonly ConformingMeshFixture[] {
  const hangingVertices = [
    [0, 0],
    [1, 0],
    [1, 3],
    [2, 0],
    [1, 1],
  ] as const;
  const hangingTriangles = [0, 1, 2, 1, 3, 4, 4, 3, 2] as const;
  return [
    {
      id: 'analytic/triangle',
      mesh: {
        vertices: [
          [0, 0],
          [4, 0],
          [0, 4],
        ],
        indices: [0, 1, 2],
      },
      expectedParentCounts: [1],
      expectedTriangleCount: 1,
      expectedTwiceArea: 16n * UNIT_SQUARED,
      expectedIndices: [0, 1, 2],
      expectedParents: [0],
    },
    {
      id: 'analytic/square',
      mesh: {
        vertices: [
          [0, 0],
          [1, 0],
          [1, 1],
          [0, 1],
        ],
        indices: [0, 1, 2, 0, 2, 3],
      },
      expectedParentCounts: [1, 1],
      expectedTriangleCount: 2,
      expectedTwiceArea: 2n * UNIT_SQUARED,
    },
    {
      id: 'analytic/hanging',
      mesh: { vertices: hangingVertices, indices: hangingTriangles },
      expectedParentCounts: [2, 1, 1],
      expectedTriangleCount: 4,
      expectedTwiceArea: 6n * UNIT_SQUARED,
      expectedIndices: [0, 1, 4, 0, 4, 2, 1, 3, 4, 2, 4, 3],
      expectedParents: [0, 0, 1, 2],
    },
    {
      id: 'analytic/hanging-reversed',
      mesh: { vertices: hangingVertices, indices: [4, 3, 2, 1, 3, 4, 0, 1, 2] },
      expectedParentCounts: [1, 1, 2],
      expectedTriangleCount: 4,
      expectedTwiceArea: 6n * UNIT_SQUARED,
    },
    {
      id: 'analytic/collinear-chain',
      mesh: {
        vertices: [
          [0, 0],
          [4, 0],
          [0, 4],
          [1, 0],
          [2, 0],
          [3, 0],
        ],
        indices: [0, 1, 2],
      },
      expectedParentCounts: [4],
      expectedTriangleCount: 4,
      expectedTwiceArea: 16n * UNIT_SQUARED,
    },
    {
      id: 'analytic/empty',
      mesh: {
        vertices: [
          [-0, 0],
          [1, 1],
        ],
        indices: [],
      },
      expectedParentCounts: [],
      expectedTriangleCount: 0,
      expectedTwiceArea: 0n,
      expectedIndices: [],
      expectedParents: [],
    },
    {
      id: 'analytic/each-side',
      mesh: {
        vertices: [
          [0, 0],
          [4, 0],
          [0, 4],
          [2, 0],
          [2, 2],
          [0, 2],
        ],
        indices: [0, 1, 2],
      },
      expectedParentCounts: [4],
      expectedTriangleCount: 4,
      expectedTwiceArea: 16n * UNIT_SQUARED,
      expectedIndices: [5, 0, 3, 3, 1, 4, 4, 2, 5, 3, 4, 5],
      expectedParents: [0, 0, 0, 0],
    },
  ];
}

function roundedCarrier(
  id: string,
  rule: 'nonzero' | 'evenodd',
  polygons: readonly (readonly Point[])[],
): ExpectedCarrier {
  const row: FixtureRow = {
    id,
    rule,
    tauBits: bitsOf(1 / 16),
    expectation: 'OK',
    profile: 'I',
    contours: polygons.map((polygon) => polygon.map(([x, y]) => [bitsOf(x), bitsOf(y)] as const)),
  };
  const result = buildRoundedFillOracle(row);
  if (!result.ok)
    throw new Error(`${id}:${rule} independent rounded carrier failed: ${result.reason}`);
  return result.carrier;
}

/** Builds the twelve independent W/Y/Z carrier sources from frozen polygons. */
export function fixedCarrierConformingMeshFixtures(): readonly CarrierConformingMeshFixture[] {
  const w = fixedNativeMixedCubicFixtureRows().map((row) => ({
    id: `carrier/W/${row.id}:${row.rule}`,
    carrier: roundedCarrier(row.id, row.rule, [row.expectedPolygon]),
    expectedParentCounts: Array<number>(8).fill(1),
    expectedTriangleCount: 8,
    expectedTwiceArea: 72n * UNIT_SQUARED,
  }));
  const y = fixedNativeTriangleFreeCubicFixtureRows().map((row) => ({
    id: `carrier/Y/${row.id}:${row.rule}`,
    carrier: roundedCarrier(row.id, row.rule, row.expectedPolygons),
    expectedParentCounts: [2, 1, 1, 1, 1, 1, 1, 1, 1, 2],
    expectedTriangleCount: 12,
    expectedTwiceArea: 963n * (1n << 2144n) - (1n << 2100n),
  }));
  const z = fixedNativeDepthPositiveCubicFixtureRows().map((row) => ({
    id: `carrier/Z/${row.id}:${row.rule}`,
    carrier: roundedCarrier(row.id, row.rule, row.expectedPolygons),
    expectedParentCounts: [1, 2, 1, 1, 1, 1, 1, 2],
    expectedTriangleCount: 10,
    expectedTwiceArea: 121n * (1n << 2147n) - (1n << 2099n),
  }));
  return [...w, ...y, ...z].map((fixture) => ({
    ...fixture,
    mesh: { vertices: fixture.carrier.vertices, indices: fixture.carrier.indices },
  }));
}
