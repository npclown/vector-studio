import type { Cubic, Point } from '../../../packages/geometry-reference/src/types.js';
import type { CubicTopologySegmentFixture } from '../simple-cubic-topology/fixtures.js';
import type { SimpleCubicTopologyStatus } from '../simple-cubic-topology/oracle.js';

export type TransverseArrangementCrossingFixture = Readonly<{
  leftLeaf: number;
  rightLeaf: number;
  orientation: -1 | 1;
}>;

export type TransverseArrangementFixture = Readonly<{
  id: string;
  contours: readonly (readonly CubicTopologySegmentFixture[])[];
  expected: Readonly<{
    leaves: number;
    pairs: number;
    polygons: readonly (readonly Point[])[];
    crossings: readonly TransverseArrangementCrossingFixture[];
  }>;
}>;

export type TransverseArrangementControl = Readonly<{
  id: string;
  contours: readonly (readonly CubicTopologySegmentFixture[])[];
  status: SimpleCubicTopologyStatus;
  leaves: number;
  pairs: number;
  findingIncludes: readonly string[];
}>;

type RawSegment = Readonly<{
  cubic: Cubic;
  endpoints: readonly Point[];
}>;
type RawContour = readonly RawSegment[];

const B = [
  [-2, -2],
  [2, 2],
  [2, 3],
  [-2, 3],
  [-2, 2],
  [2, -2],
  [2, -3],
  [-2, -3],
] as const satisfies readonly Point[];

const B_REFLECT_X = [
  [2, -2],
  [-2, 2],
  [-2, 3],
  [2, 3],
  [2, 2],
  [-2, -2],
  [-2, -3],
  [2, -3],
] as const satisfies readonly Point[];

const B_REVERSE = [
  [-2, -2],
  [-2, -3],
  [2, -3],
  [2, -2],
  [-2, 2],
  [-2, 3],
  [2, 3],
  [2, 2],
] as const satisfies readonly Point[];

const B_ROTATED = [
  [2, 2],
  [2, 3],
  [-2, 3],
  [-2, 2],
  [2, -2],
  [2, -3],
  [-2, -3],
  [-2, -2],
] as const satisfies readonly Point[];

const SQUARE_A = [
  [0, 0],
  [4, 0],
  [4, 4],
  [0, 4],
] as const satisfies readonly Point[];
const SQUARE_B = [
  [2, -2],
  [6, -2],
  [6, 2],
  [2, 2],
] as const satisfies readonly Point[];
const SQUARE_A_REFLECT_X = [
  [-0, 0],
  [-4, 0],
  [-4, 4],
  [-0, 4],
] as const satisfies readonly Point[];
const SQUARE_B_REFLECT_X = [
  [-2, -2],
  [-6, -2],
  [-6, 2],
  [-2, 2],
] as const satisfies readonly Point[];

const point = (x: number, y: number): Point => [x, y];

function linearCubic(start: Point, end: Point): Cubic {
  return [
    start,
    point((3 * start[0] + end[0]) / 4, (3 * start[1] + end[1]) / 4),
    point((start[0] + 3 * end[0]) / 4, (start[1] + 3 * end[1]) / 4),
    end,
  ];
}

function closedStraightContour(vertices: readonly Point[]): RawContour {
  return vertices.map((start, index) =>
    rawSegment(linearCubic(start, vertices[(index + 1) % vertices.length]!), [
      vertices[(index + 1) % vertices.length]!,
    ]),
  );
}

function openStraightContour(vertices: readonly Point[]): RawContour {
  return vertices
    .slice(0, -1)
    .map((start, index) =>
      rawSegment(linearCubic(start, vertices[index + 1]!), [vertices[index + 1]!]),
    );
}

function rawSegment(cubic: Cubic, endpoints: readonly Point[]): RawSegment {
  return { cubic, endpoints };
}

function mapContour(contour: RawContour, transform: (value: Point) => Point): RawContour {
  return contour.map((segment) => ({
    cubic: segment.cubic.map(transform) as unknown as Cubic,
    endpoints: segment.endpoints.map(transform),
  }));
}

function reverseContour(contour: RawContour): RawContour {
  return [...contour].reverse().map((segment) => ({
    cubic: [...segment.cubic].reverse() as unknown as Cubic,
    endpoints: [segment.cubic[0]],
  }));
}

function nContour(): RawContour {
  const contour = [...closedStraightContour(B)];
  contour[0] = rawSegment([B[0], [-1, -15 / 16], [1, 15 / 16], B[1]], [B[1]]);
  contour[4] = rawSegment([B[4], [-1, 17 / 16], [1, -17 / 16], B[5]], [B[5]]);
  return contour;
}

function rotatedContour(curved: boolean): RawContour {
  const contour = [...openStraightContour(B_ROTATED)];
  if (curved) {
    contour[3] = rawSegment(
      [B_ROTATED[3], [-1, 17 / 16], [1, -17 / 16], B_ROTATED[4]],
      [B_ROTATED[4]],
    );
  }
  return contour;
}

function toSegments(
  contours: readonly RawContour[],
): readonly (readonly CubicTopologySegmentFixture[])[] {
  let sourceVerbOrdinal = 1;
  return contours.map((contour) =>
    contour.map((segment) => {
      const ordinal = sourceVerbOrdinal;
      sourceVerbOrdinal += 1;
      const depth = Math.log2(segment.endpoints.length);
      return {
        cubic: segment.cubic,
        sourceVerbOrdinal: ordinal,
        lines: segment.endpoints.map((end, index) => ({
          end,
          provenance: {
            sourceVerbOrdinal: ordinal,
            endNumerator: index + 1,
            depth,
          },
        })),
      };
    }),
  );
}

function positive(
  id: string,
  rawContours: readonly RawContour[],
  polygons: readonly (readonly Point[])[],
  crossings: readonly TransverseArrangementCrossingFixture[],
): TransverseArrangementFixture {
  return {
    id,
    contours: toSegments(rawContours),
    expected: { leaves: 8, pairs: 28, polygons, crossings },
  };
}

/** Returns the frozen twelve transverse-arrangement positives in contract order. */
export function fixedTransverseArrangementFixtures(): readonly TransverseArrangementFixture[] {
  const b = closedStraightContour(B);
  const n = nContour();
  return [
    positive('B-explicit', [b], [B], [{ leftLeaf: 0, rightLeaf: 4, orientation: -1 }]),
    positive(
      'B-reflect-x',
      [mapContour(b, ([x, y]) => [-x, y])],
      [B_REFLECT_X],
      [{ leftLeaf: 0, rightLeaf: 4, orientation: 1 }],
    ),
    positive(
      'B-reverse',
      [reverseContour(b)],
      [B_REVERSE],
      [{ leftLeaf: 3, rightLeaf: 7, orientation: 1 }],
    ),
    positive('N-explicit', [n], [B], [{ leftLeaf: 0, rightLeaf: 4, orientation: -1 }]),
    positive(
      'N-reflect-x',
      [mapContour(n, ([x, y]) => [-x, y])],
      [B_REFLECT_X],
      [{ leftLeaf: 0, rightLeaf: 4, orientation: 1 }],
    ),
    positive(
      'N-reverse',
      [reverseContour(n)],
      [B_REVERSE],
      [{ leftLeaf: 3, rightLeaf: 7, orientation: 1 }],
    ),
    positive('B-implicit', [b.slice(0, 7)], [B], [{ leftLeaf: 0, rightLeaf: 4, orientation: -1 }]),
    positive('N-implicit', [n.slice(0, 7)], [B], [{ leftLeaf: 0, rightLeaf: 4, orientation: -1 }]),
    positive(
      'closure-crossing',
      [rotatedContour(false)],
      [B_ROTATED],
      [{ leftLeaf: 3, rightLeaf: 7, orientation: 1 }],
    ),
    positive(
      'closure-crossing-curved',
      [rotatedContour(true)],
      [B_ROTATED],
      [{ leftLeaf: 3, rightLeaf: 7, orientation: 1 }],
    ),
    positive(
      'overlapping-squares',
      [closedStraightContour(SQUARE_A), closedStraightContour(SQUARE_B)],
      [SQUARE_A, SQUARE_B],
      [
        { leftLeaf: 0, rightLeaf: 7, orientation: -1 },
        { leftLeaf: 1, rightLeaf: 6, orientation: 1 },
      ],
    ),
    positive(
      'overlapping-squares-reflect-x',
      [closedStraightContour(SQUARE_A_REFLECT_X), closedStraightContour(SQUARE_B_REFLECT_X)],
      [SQUARE_A_REFLECT_X, SQUARE_B_REFLECT_X],
      [
        { leftLeaf: 0, rightLeaf: 7, orientation: 1 },
        { leftLeaf: 1, rightLeaf: 6, orientation: -1 },
      ],
    ),
  ];
}

function control(
  id: string,
  rawContours: readonly RawContour[],
  leaves: number,
  pairs: number,
  findingIncludes: readonly string[],
): TransverseArrangementControl {
  return {
    id,
    contours: toSegments(rawContours),
    status: 'UNRESOLVED',
    leaves,
    pairs,
    findingIncludes,
  };
}

/** Returns the frozen five new transverse-arrangement rejections in contract order. */
export function transverseArrangementControls(): readonly TransverseArrangementControl[] {
  const multiple = [
    [-3, 0],
    [3, 0],
    [3, 3],
    [-1, 3],
    [-1, -1],
    [1, -1],
    [1, 2],
    [-3, 2],
  ] as const satisfies readonly Point[];
  const triple = [
    [-3, 0],
    [3, 0],
    [3, 3],
    [0, 3],
    [0, -3],
    [-2, -2],
    [2, 2],
    [-3, 2],
  ] as const satisfies readonly Point[];
  const rectangle = [
    [-4, 0],
    [4, 0],
    [4, -4],
    [-4, -4],
  ] as const satisfies readonly Point[];
  const tangent: RawContour = [
    rawSegment(
      [
        [-3, 3],
        [-1, -1],
        [1, -1],
        [3, 3],
      ],
      [
        [0, -1],
        [3, 3],
      ],
    ),
    ...openStraightContour([
      [3, 3],
      [3, 5],
      [-3, 5],
      [-3, 3],
    ]),
  ];
  const contactSquare = SQUARE_A.map(([x, y]) => point(x + 4, y));
  return [
    control('multiple-partners', [closedStraightContour(multiple)], 8, 5, [
      'multiple transverse partners',
      '0,5',
    ]),
    control('triple-coincidence', [closedStraightContour(triple)], 8, 5, [
      'multiple transverse partners',
      '0,5',
    ]),
    control('tangent-displaced-knot', [closedStraightContour(rectangle), tangent], 9, 4, [
      'nonadjacent',
      '0,4',
    ]),
    control(
      'coincident-squares',
      [closedStraightContour(SQUARE_A), closedStraightContour(SQUARE_A)],
      8,
      4,
      ['nonadjacent', '0,4'],
    ),
    control(
      'contact-squares',
      [closedStraightContour(SQUARE_A), closedStraightContour(contactSquare)],
      8,
      4,
      ['nonadjacent', '0,4'],
    ),
  ];
}
