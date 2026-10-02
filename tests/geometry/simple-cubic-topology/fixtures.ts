import type {
  Cubic,
  Point,
  ReferenceFlattenedLine,
} from '../../../packages/geometry-reference/src/types.js';
import { uniformCubicFixtureLines } from '../cubic-boundary/fixtures.js';

export type CubicTopologySegmentFixture = Readonly<{
  cubic: Cubic;
  sourceVerbOrdinal: number;
  lines: readonly ReferenceFlattenedLine[];
}>;

export type SimpleCubicTopologyFixture = Readonly<{
  id: string;
  contours: readonly (readonly CubicTopologySegmentFixture[])[];
  expected: Readonly<{
    polygons: readonly (readonly Point[])[];
    orientations: readonly (-1 | 1)[];
    winding: readonly (readonly (-1 | 0 | 1)[])[];
  }>;
}>;

export type SimpleCubicTopologyControl = Readonly<{
  id: string;
  contours: readonly (readonly CubicTopologySegmentFixture[])[];
  status: 'CERTIFIED' | 'INVALID_INPUT' | 'INVALID_PROVENANCE' | 'KNOT_MISMATCH' | 'UNRESOLVED';
}>;

type SourceContour = readonly Cubic[];
type BaseCase = Readonly<{
  id: string;
  contours: readonly SourceContour[];
  orientations: readonly (-1 | 1)[];
  ancestors: readonly (readonly number[])[];
}>;

const Q = [
  [4, 0],
  [4, 2],
  [2, 4],
  [0, 4],
] as const satisfies Cubic;

const pointEquals = (left: Point, right: Point): boolean =>
  left[0] === right[0] && left[1] === right[1];

function mapCubic(cubic: Cubic, transform: (point: Point) => Point): Cubic {
  return cubic.map(transform) as unknown as Cubic;
}

function mapContour(contour: SourceContour, transform: (point: Point) => Point): SourceContour {
  return contour.map((cubic) => mapCubic(cubic, transform));
}

function rotateQuarter(cubic: Cubic): Cubic {
  return mapCubic(cubic, ([x, y]) => [-y, x]);
}

function diamond(scale = 1, dx = 0, dy = 0): SourceContour {
  const quarters: Cubic[] = [Q];
  for (let index = 1; index < 4; index += 1) quarters.push(rotateQuarter(quarters[index - 1]!));
  return quarters.map((cubic) => mapCubic(cubic, ([x, y]) => [x * scale + dx, y * scale + dy]));
}

function reverseContour(contour: SourceContour): SourceContour {
  return [...contour].reverse().map((cubic) => [...cubic].reverse() as unknown as Cubic);
}

function sourceContoursToSegments(
  contours: readonly SourceContour[],
  depth = 2,
): readonly (readonly CubicTopologySegmentFixture[])[] {
  let sourceVerbOrdinal = 7;
  return contours.map((contour) =>
    contour.map((cubic) => {
      const ordinal = sourceVerbOrdinal;
      sourceVerbOrdinal += 1;
      return {
        cubic,
        sourceVerbOrdinal: ordinal,
        lines: uniformCubicFixtureLines(cubic, depth, ordinal),
      };
    }),
  );
}

function sourceContoursToDepthZeroSegments(
  contours: readonly SourceContour[],
): readonly (readonly CubicTopologySegmentFixture[])[] {
  let sourceVerbOrdinal = 7;
  return contours.map((contour) =>
    contour.map((cubic) => {
      const ordinal = sourceVerbOrdinal;
      sourceVerbOrdinal += 1;
      return {
        cubic,
        sourceVerbOrdinal: ordinal,
        lines: [
          {
            end: cubic[3],
            provenance: { sourceVerbOrdinal: ordinal, endNumerator: 1, depth: 0 },
          },
        ],
      };
    }),
  );
}

function expectedPolygons(
  contours: readonly (readonly CubicTopologySegmentFixture[])[],
): readonly (readonly Point[])[] {
  return contours.map((contour) => {
    const polygon: Point[] = [];
    for (const segment of contour) {
      let start = segment.cubic[0];
      for (const line of segment.lines) {
        polygon.push(start);
        start = line.end;
      }
    }
    const first = contour[0]!.cubic[0];
    const lastSegment = contour[contour.length - 1]!;
    const last = lastSegment.lines[lastSegment.lines.length - 1]!.end;
    if (!pointEquals(last, first)) polygon.push(last);
    return polygon;
  });
}

function expectedWinding(
  orientations: readonly (-1 | 1)[],
  ancestors: readonly (readonly number[])[],
): readonly (readonly (-1 | 0 | 1)[])[] {
  return orientations.map((_, contourIndex) =>
    orientations.map((orientation, candidateAncestor) =>
      ancestors[contourIndex]!.includes(candidateAncestor) ? orientation : 0,
    ),
  );
}

function fixture(
  id: string,
  sourceContours: readonly SourceContour[],
  orientations: readonly (-1 | 1)[],
  ancestors: readonly (readonly number[])[],
  depth = 2,
): SimpleCubicTopologyFixture {
  const contours = sourceContoursToSegments(sourceContours, depth);
  return {
    id,
    contours,
    expected: {
      polygons: expectedPolygons(contours),
      orientations,
      winding: expectedWinding(orientations, ancestors),
    },
  };
}

function permuteBase(base: BaseCase, order: readonly number[], id: string): BaseCase {
  const inverse = new Map(order.map((oldIndex, newIndex) => [oldIndex, newIndex]));
  return {
    id,
    contours: order.map((index) => base.contours[index]!),
    orientations: order.map((index) => base.orientations[index]!),
    ancestors: order.map((oldIndex) =>
      base.ancestors[oldIndex]!.map((ancestor) => inverse.get(ancestor)!),
    ),
  };
}

function baseCases(): readonly BaseCase[] {
  const d = diamond();
  const half = diamond(1 / 2);
  const quarter = diamond(1 / 4);
  return [
    { id: 'C01', contours: [d], orientations: [1], ancestors: [[]] },
    { id: 'C02', contours: [d, half], orientations: [1, 1], ancestors: [[], [0]] },
    {
      id: 'C03',
      contours: [d, reverseContour(half)],
      orientations: [1, -1],
      ancestors: [[], [0]],
    },
    { id: 'C04', contours: [d.slice(0, 3)], orientations: [1], ancestors: [[]] },
    {
      id: 'C05',
      contours: [diamond(1, 0, 0), diamond(1, 16, 0), diamond(1, 32, 0), diamond(1, 48, 0)],
      orientations: [1, 1, 1, 1],
      ancestors: [[], [], [], []],
    },
    {
      id: 'C06',
      contours: [d, half, quarter],
      orientations: [1, 1, 1],
      ancestors: [[], [0], [0, 1]],
    },
    {
      id: 'C07',
      contours: [d, reverseContour(half), quarter],
      orientations: [1, -1, 1],
      ancestors: [[], [0], [0, 1]],
    },
    { id: 'C08', contours: [reverseContour(d)], orientations: [-1], ancestors: [[]] },
  ];
}

function transformBase(
  base: BaseCase,
  idSuffix: string,
  transform: (contour: SourceContour) => SourceContour,
  orientationFactor: -1 | 1,
): SimpleCubicTopologyFixture {
  return fixture(
    `${base.id}/${idSuffix}`,
    base.contours.map(transform),
    base.orientations.map((orientation) => (orientation * orientationFactor) as -1 | 1),
    base.ancestors,
  );
}

function linearCubic(start: Point, firstThird: Point, secondThird: Point, end: Point): Cubic {
  return [start, firstThird, secondThird, end];
}

function extremeSquare(a: number): SourceContour {
  return [
    linearCubic([0, 0], [a, 0], [2 * a, 0], [3 * a, 0]),
    linearCubic([3 * a, 0], [3 * a, a], [3 * a, 2 * a], [3 * a, 3 * a]),
    linearCubic([3 * a, 3 * a], [2 * a, 3 * a], [a, 3 * a], [0, 3 * a]),
    linearCubic([0, 3 * a], [0, 2 * a], [0, a], [0, 0]),
  ];
}

function extremeFixture(id: string, a: number): SimpleCubicTopologyFixture {
  const contours = sourceContoursToDepthZeroSegments([extremeSquare(a)]);
  return {
    id,
    contours,
    expected: { polygons: expectedPolygons(contours), orientations: [1], winding: [[0]] },
  };
}

/** Returns the frozen 47-case topology corpus in contract order. */
export function fixedSimpleCubicTopologyFixtures(): readonly SimpleCubicTopologyFixture[] {
  const bases = baseCases();
  const fixtures: SimpleCubicTopologyFixture[] = [];
  for (const base of bases) {
    fixtures.push(transformBase(base, 'identity', (contour) => contour, 1));
    fixtures.push(
      transformBase(
        base,
        'translate',
        (contour) => mapContour(contour, ([x, y]) => [x + 2 ** 20, y - 2 ** 20]),
        1,
      ),
    );
    fixtures.push(
      transformBase(base, 'reflect', (contour) => mapContour(contour, ([x, y]) => [-x, y]), -1),
    );
    fixtures.push(
      transformBase(
        base,
        'scale-half',
        (contour) => mapContour(contour, ([x, y]) => [x / 2, y / 2]),
        1,
      ),
    );
    fixtures.push(transformBase(base, 'reverse', reverseContour, -1));
  }

  for (const id of ['C02', 'C03', 'C05', 'C06', 'C07']) {
    const base = baseCases().find((candidate) => candidate.id === id)!;
    const order = base.contours.map((_, index) => base.contours.length - 1 - index);
    const permuted = permuteBase(base, order, `${id}/reverse-contour-order`);
    fixtures.push(
      fixture(permuted.id, permuted.contours, permuted.orientations, permuted.ancestors),
    );
  }

  fixtures.push(extremeFixture('extreme/min-subnormal-square', Number.MIN_VALUE));
  fixtures.push(extremeFixture('extreme/large-square', 2 ** 1021));
  return fixtures;
}

function control(
  id: string,
  contours: readonly SourceContour[],
  depth = 2,
): SimpleCubicTopologyControl {
  return {
    id,
    contours:
      depth === 0
        ? sourceContoursToDepthZeroSegments(contours)
        : sourceContoursToSegments(contours, depth),
    status: 'UNRESOLVED',
  };
}

/** Returns the named data-only rejecting controls whose expectation is fixed analytically. */
export function simpleCubicTopologyRejectingControls(): readonly SimpleCubicTopologyControl[] {
  const tinyLoop = [
    [0, 0],
    [1 / 16, 1 / 16],
    [-1 / 16, 1 / 16],
    [0, 0],
  ] as const satisfies Cubic;
  const negativeProjection = [
    [0, 0],
    [2 / 128, 0],
    [-1 / 128, 0],
    [1 / 128, 0],
  ] as const satisfies Cubic;
  const bowtieCorners = [
    [0, 0],
    [6, 6],
    [0, 6],
    [6, 0],
  ] as const satisfies readonly Point[];
  const bowtie = bowtieCorners.map((start, index) => {
    const end = bowtieCorners[(index + 1) % bowtieCorners.length]!;
    const dx = (end[0] - start[0]) / 3;
    const dy = (end[1] - start[1]) / 3;
    return linearCubic(
      start,
      [start[0] + dx, start[1] + dy],
      [start[0] + 2 * dx, start[1] + 2 * dy],
      end,
    );
  });
  const adjacentOverlapCorners = [
    [0, 0],
    [6, 0],
    [3, 0],
    [3, 3],
  ] as const satisfies readonly Point[];
  const adjacentOverlap = adjacentOverlapCorners.map((start, index) => {
    const end = adjacentOverlapCorners[(index + 1) % adjacentOverlapCorners.length]!;
    const dx = (end[0] - start[0]) / 3;
    const dy = (end[1] - start[1]) / 3;
    return linearCubic(
      start,
      [start[0] + dx, start[1] + dy],
      [start[0] + 2 * dx, start[1] + 2 * dy],
      end,
    );
  });
  return [
    control('tiny-zero-chord-loop', [[tinyLoop]], 0),
    control('negative-projection', [[negativeProjection]], 0),
    control('bowtie-crossing', [bowtie], 0),
    control('adjacent-collinear-overlap', [adjacentOverlap], 0),
    control('cross-contour-contact', [diamond(), diamond(1, 8, 0)]),
    control('coincident-contours', [diamond(), diamond()]),
    control('near-contact-hull-overlap', [diamond(), diamond(1023 / 1024)]),
  ];
}
