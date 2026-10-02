import type { Cubic, Point } from '../../../packages/geometry-reference/src/types.js';
import type {
  CubicTopologySegmentFixture,
  SimpleCubicTopologyFixture,
} from '../simple-cubic-topology/fixtures.js';

type RawSegment = Readonly<{
  cubic: Cubic;
  endpoints: readonly Point[];
  provenance?: readonly Readonly<{ endNumerator: number; depth: number }>[];
}>;
type RawContour = readonly RawSegment[];

export type RoundedKnotTopologyFixture = SimpleCubicTopologyFixture &
  Readonly<{ oldStatus: 'CERTIFIED' | 'KNOT_MISMATCH' }>;

export type RoundedKnotTopologyControl = Readonly<{
  id: string;
  contours: readonly (readonly CubicTopologySegmentFixture[])[];
  status: 'KNOT_MISMATCH' | 'UNRESOLVED';
  leaves: number;
  pairs: number;
  findingIncludes?: string;
}>;

const E = 2 ** -54;
const A = [0, 0] as const satisfies Point;
const B = [3, 0] as const satisfies Point;
const C = [3 / 2, -3] as const satisfies Point;

const point = (x: number, y: number): Point => [x, y];
const samePoint = (left: Point, right: Point): boolean =>
  left[0] === right[0] && left[1] === right[1];

function linearCubic(start: Point, end: Point): Cubic {
  return [
    start,
    point((2 * start[0] + end[0]) / 3, (2 * start[1] + end[1]) / 3),
    point((start[0] + 2 * end[0]) / 3, (start[1] + 2 * end[1]) / 3),
    end,
  ];
}

function uniformLinearSegment(start: Point, end: Point, depth: 0 | 1 | 2): RawSegment {
  const count = 2 ** depth;
  return {
    cubic: linearCubic(start, end),
    endpoints: Array.from({ length: count }, (_, index) => {
      const numerator = index + 1;
      return point(
        start[0] + ((end[0] - start[0]) * numerator) / count,
        start[1] + ((end[1] - start[1]) * numerator) / count,
      );
    }),
  };
}

function roundedTriangle(rounded: boolean): RawContour {
  const e = rounded ? E : 0;
  return [
    {
      cubic: [A, [1, e], [2, 1], B],
      endpoints: [[3 / 4, 9 / 64 + (e === 0 ? 0 : 2 ** -55)], [3 / 2, 3 / 8], [9 / 4, 27 / 64], B],
    },
    {
      cubic: [B, [5 / 2, -1], [2, -2], C],
      endpoints: [[21 / 8, -3 / 4], [9 / 4, -3 / 2], [15 / 8, -9 / 4], C],
    },
    {
      cubic: [C, [1, -2], [1 / 2, -1], A],
      endpoints: [[9 / 8, -9 / 4], [3 / 4, -3 / 2], [3 / 8, -3 / 4], A],
    },
  ];
}

function mapPoint(value: Point, transform: (point: Point) => Point): Point {
  return transform(value);
}

function mapSegment(segment: RawSegment, transform: (point: Point) => Point): RawSegment {
  return {
    cubic: [
      mapPoint(segment.cubic[0], transform),
      mapPoint(segment.cubic[1], transform),
      mapPoint(segment.cubic[2], transform),
      mapPoint(segment.cubic[3], transform),
    ],
    endpoints: segment.endpoints.map((endpoint) => mapPoint(endpoint, transform)),
    ...(segment.provenance === undefined ? {} : { provenance: segment.provenance }),
  };
}

function mapContour(contour: RawContour, transform: (point: Point) => Point): RawContour {
  return contour.map((segment) => mapSegment(segment, transform));
}

function reverseContour(contour: RawContour): RawContour {
  return [...contour].reverse().map((segment) => {
    const starts = [segment.cubic[0], ...segment.endpoints.slice(0, -1)];
    return {
      cubic: [segment.cubic[3], segment.cubic[2], segment.cubic[1], segment.cubic[0]],
      endpoints: [...starts].reverse(),
    };
  });
}

function toSegments(
  contours: readonly RawContour[],
): readonly (readonly CubicTopologySegmentFixture[])[] {
  let ordinal = 7;
  return contours.map((contour) =>
    contour.map((segment) => {
      const sourceVerbOrdinal = ordinal;
      ordinal += 1;
      const depth = Math.log2(segment.endpoints.length);
      return {
        cubic: segment.cubic,
        sourceVerbOrdinal,
        lines: segment.endpoints.map((end, index) => {
          const supplied = segment.provenance?.[index];
          return {
            end,
            provenance: {
              sourceVerbOrdinal,
              endNumerator: supplied?.endNumerator ?? index + 1,
              depth: supplied?.depth ?? depth,
            },
          };
        }),
      };
    }),
  );
}

function polygons(
  contours: readonly (readonly CubicTopologySegmentFixture[])[],
): readonly (readonly Point[])[] {
  return contours.map((contour) => {
    const result: Point[] = [];
    let start = contour[0]!.cubic[0];
    for (const segment of contour) {
      for (const line of segment.lines) {
        result.push(start);
        start = line.end;
      }
    }
    if (!samePoint(start, contour[0]!.cubic[0])) result.push(start);
    return result;
  });
}

function fixture(
  id: string,
  rawContours: readonly RawContour[],
  orientations: readonly (-1 | 1)[],
  oldStatus: RoundedKnotTopologyFixture['oldStatus'],
): RoundedKnotTopologyFixture {
  const contours = toSegments(rawContours);
  return {
    id,
    contours,
    oldStatus,
    expected: {
      polygons: polygons(contours),
      orientations,
      winding: orientations.map(() => orientations.map(() => 0 as const)),
    },
  };
}

function translated(contour: RawContour, dx: number, dy = 0): RawContour {
  return mapContour(contour, ([x, y]) => [x + dx, y + dy]);
}

function closurePositive(): RawContour {
  const upper = roundedTriangle(true)[0]!;
  return [upper, uniformLinearSegment(B, [0, -3 / 2], 2)];
}

/** Returns the frozen eleven positive rounded-knot certificate fixtures in contract order. */
export function fixedRoundedKnotTopologyFixtures(): readonly RoundedKnotTopologyFixture[] {
  const fixtures: RoundedKnotTopologyFixture[] = [];
  for (const [label, rounded, oldStatus] of [
    ['rounded', true, 'KNOT_MISMATCH'],
    ['exact', false, 'CERTIFIED'],
  ] as const) {
    const base = roundedTriangle(rounded);
    fixtures.push(fixture(`${label}/identity`, [base], [-1], oldStatus));
    fixtures.push(
      fixture(`${label}/reflect-x`, [mapContour(base, ([x, y]) => [-x, y])], [1], oldStatus),
    );
    fixtures.push(
      fixture(
        `${label}/scale-half`,
        [mapContour(base, ([x, y]) => [x / 2, y / 2])],
        [-1],
        oldStatus,
      ),
    );
    fixtures.push(fixture(`${label}/reverse`, [reverseContour(base)], [1], oldStatus));
  }
  const copies = [0, 16, 32, 48].map((dx) => translated(roundedTriangle(true), dx));
  fixtures.push(fixture('rounded/four-disjoint', copies, [-1, -1, -1, -1], 'KNOT_MISMATCH'));
  fixtures.push(
    fixture(
      'rounded/four-disjoint-reverse-order',
      [...copies].reverse(),
      [-1, -1, -1, -1],
      'KNOT_MISMATCH',
    ),
  );
  fixtures.push(fixture('rounded/implicit-closure', [closurePositive()], [-1], 'KNOT_MISMATCH'));
  return fixtures;
}

function replaceEndpoint(
  contour: RawContour,
  segmentIndex: number,
  endpointIndex: number,
  endpoint: Point,
): RawContour {
  return contour.map((segment, currentSegment) =>
    currentSegment === segmentIndex
      ? {
          ...segment,
          endpoints: segment.endpoints.map((value, currentEndpoint) =>
            currentEndpoint === endpointIndex ? endpoint : value,
          ),
        }
      : segment,
  );
}

function square(
  left: number,
  right: number,
  bottom: number,
  top: number,
  depth: 0 | 1,
): RawContour {
  const corners = [point(left, bottom), point(right, bottom), point(right, top), point(left, top)];
  return corners.map((start, index) =>
    uniformLinearSegment(start, corners[(index + 1) % corners.length]!, depth),
  );
}

function perturbedSquare(): RawContour {
  return replaceEndpoint(square(0, 3, 0, 3, 1), 1, 0, [6, 3 / 2]);
}

function cyclicOnly(): RawContour {
  return [
    uniformLinearSegment([0, 0], [9, 0], 0),
    {
      cubic: [
        [9, 0],
        [7, -3],
        [5, -6],
        [3, -9],
      ],
      endpoints: [
        [6, -9 / 2],
        [3, -9],
      ],
    },
    {
      cubic: [
        [3, -9],
        [2, -6],
        [1, -3],
        [0, 0],
      ],
      endpoints: [
        [3 / 2, -9 / 2],
        [3 / 4, -9 / 4],
        [0, 0],
      ],
      provenance: [
        { endNumerator: 1, depth: 1 },
        { endNumerator: 3, depth: 2 },
        { endNumerator: 4, depth: 2 },
      ],
    },
  ];
}

/** Returns the literal topology-specific rejecting controls and their exact counters. */
export function roundedKnotTopologyControls(): readonly RoundedKnotTopologyControl[] {
  const base = roundedTriangle(true);
  const endpointMismatch = replaceEndpoint(base, 0, 3, [3, Number.MIN_VALUE]);
  const containment = [perturbedSquare(), square(4, 67 / 16, 1, 19 / 16, 0)] as const;
  return [
    {
      id: 'source-end-mismatch',
      contours: toSegments([endpointMismatch]),
      status: 'KNOT_MISMATCH',
      leaves: 0,
      pairs: 0,
    },
    {
      id: 'collapsed-actual-chord',
      contours: toSegments([replaceEndpoint(base, 0, 0, A)]),
      status: 'UNRESOLVED',
      leaves: 12,
      pairs: 1,
      findingIncludes: 'adjacent',
    },
    {
      id: 'reversed-actual-chord',
      contours: toSegments([replaceEndpoint(base, 0, 0, [-3 / 4, 0])]),
      status: 'UNRESOLVED',
      leaves: 12,
      pairs: 1,
      findingIncludes: 'adjacent',
    },
    {
      id: 'cyclic-only-projection',
      contours: toSegments([cyclicOnly()]),
      status: 'UNRESOLVED',
      leaves: 6,
      pairs: 5,
      findingIncludes: 'adjacent',
    },
    {
      id: 'expanded-hull-contact',
      contours: toSegments([perturbedSquare(), square(6, 9, 0, 3, 1)]),
      status: 'UNRESOLVED',
      leaves: 16,
      pairs: 41,
      findingIncludes: 'nonadjacent',
    },
    {
      id: 'expanded-hull-containment',
      contours: toSegments(containment),
      status: 'UNRESOLVED',
      leaves: 12,
      pairs: 27,
      findingIncludes: 'nonadjacent',
    },
    {
      id: 'late-source-end-mismatch',
      contours: toSegments([translated(base, -16), endpointMismatch]),
      status: 'KNOT_MISMATCH',
      leaves: 0,
      pairs: 0,
    },
    {
      id: 'late-expanded-containment',
      contours: toSegments([translated(base, -16), ...containment]),
      status: 'UNRESOLVED',
      leaves: 24,
      pairs: 237,
      findingIncludes: 'nonadjacent',
    },
  ];
}

/** Data-only one- and two-leaf controls for the minimum closed-polygon rule. */
export function roundedKnotMinimumLeafControls(): readonly RoundedKnotTopologyControl[] {
  const constant: RawSegment = {
    cubic: [
      [0, 0],
      [0, 0],
      [0, 0],
      [0, 0],
    ],
    endpoints: [[0, 0]],
  };
  return [
    {
      id: 'single-constant-leaf',
      contours: toSegments([[constant]]),
      status: 'UNRESOLVED',
      leaves: 1,
      pairs: 0,
    },
    {
      id: 'single-open-line-plus-closure',
      contours: toSegments([[uniformLinearSegment([0, 0], [3, 0], 0)]]),
      status: 'UNRESOLVED',
      leaves: 2,
      pairs: 0,
    },
  ];
}
