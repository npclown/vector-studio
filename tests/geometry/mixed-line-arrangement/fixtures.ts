import type { Cubic, Point } from '../../../packages/geometry-reference/src/types.js';
import type { CubicTopologySegmentFixture } from '../simple-cubic-topology/fixtures.js';
import type { TransverseArrangementCrossingFixture } from '../transverse-arrangement/fixtures.js';

export type MixedLineArrangementFixture = Readonly<{
  id: string;
  contours: readonly (readonly CubicTopologySegmentFixture[])[];
  sourceKinds: readonly boolean[];
  expected: Readonly<{
    leaves: number;
    pairs: number;
    polygons: readonly (readonly Point[])[];
    crossings: readonly TransverseArrangementCrossingFixture[];
  }>;
  allFalse: Readonly<{ leaves: number; pairs: number }>;
}>;

export type MixedLineArrangementControl = Readonly<{
  id: string;
  contours: readonly (readonly CubicTopologySegmentFixture[])[];
  sourceKinds: readonly boolean[];
  leaves: number;
  pairs: number;
}>;

const B = [
  [-3, -3],
  [3, 3],
  [3, 9 / 2],
  [-3, 9 / 2],
  [-3, 3],
  [3, -3],
  [3, -9 / 2],
  [-3, -9 / 2],
] as const satisfies readonly Point[];
const R = [B[1], B[2], B[3], B[4], B[5], B[6], B[7], B[0]] as const;
const M = [
  [-9, 0],
  [9, 0],
  [9, 9],
  [-3, 9],
  [-3, -3],
  [3, -3],
  [3, 6],
  [-9, 6],
] as const satisfies readonly Point[];

function linearCubic(start: Point, end: Point): Cubic {
  return [
    start,
    [(2 * start[0] + end[0]) / 3, (2 * start[1] + end[1]) / 3],
    [(start[0] + 2 * end[0]) / 3, (start[1] + 2 * end[1]) / 3],
    end,
  ];
}

function lineAdapter(start: Point, end: Point): Cubic {
  return [start, start, end, end];
}

function nonlinearN(): readonly Cubic[] {
  return B.map((start, index) => {
    const end = B[(index + 1) % B.length]!;
    if (index === 0) return [start, [-1, -1 + 1 / 16], [1, 1 - 1 / 16], end] as const;
    if (index === 4) return [start, [-1, 1 + 1 / 16], [1, -1 - 1 / 16], end] as const;
    return linearCubic(start, end);
  });
}

function withMarkedLines(cubics: readonly Cubic[], marks: readonly boolean[]): readonly Cubic[] {
  return cubics.map((cubic, index) => (marks[index] ? lineAdapter(cubic[0], cubic[3]) : cubic));
}

function mapCubic(cubic: Cubic, transform: (point: Point) => Point): Cubic {
  const [zero, one, two, three] = cubic;
  return [transform(zero), transform(one), transform(two), transform(three)];
}

function segments(
  cubics: readonly Cubic[],
  ordinals: readonly number[],
): readonly CubicTopologySegmentFixture[] {
  if (cubics.length !== ordinals.length) throw new Error('mixed fixture ordinal count mismatch');
  return cubics.map((cubic, index) => {
    const sourceVerbOrdinal = ordinals[index]!;
    return {
      cubic,
      sourceVerbOrdinal,
      lines: [
        {
          end: cubic[3],
          provenance: { sourceVerbOrdinal, endNumerator: 1, depth: 0 },
        },
      ],
    };
  });
}

function sequentialOrdinals(start: number, count: number): readonly number[] {
  return Array.from({ length: count }, (_, index) => start + index);
}

function positive(
  id: string,
  contours: readonly (readonly CubicTopologySegmentFixture[])[],
  sourceKinds: readonly boolean[],
  polygons: readonly (readonly Point[])[],
  crossings: readonly TransverseArrangementCrossingFixture[],
  leaves: number,
  pairs: number,
  allFalsePairs: number,
): MixedLineArrangementFixture {
  return {
    id,
    contours,
    sourceKinds,
    expected: { leaves, pairs, polygons, crossings },
    allFalse: { leaves, pairs: allFalsePairs },
  };
}

/** Returns the unadapted frozen N source for isolated preflight controls. */
export function fixedMixedLineNContours(): readonly (readonly CubicTopologySegmentFixture[])[] {
  return [segments(nonlinearN(), sequentialOrdinals(1, 8))];
}

/** Returns the seven frozen mixed LINE/cubic positives in contract order. */
export function fixedMixedLineArrangementFixtures(): readonly MixedLineArrangementFixture[] {
  const n = nonlinearN();
  const lineCubicKinds = [true, false, false, false, false, false, false, false] as const;
  const lineLineKinds = [true, false, false, false, true, false, false, false] as const;
  const lineCubic = withMarkedLines(n, lineCubicKinds);
  const lineLine = withMarkedLines(n, lineLineKinds);
  const closureKinds = [false, false, false, true, false, false, false] as const;
  const closure = withMarkedLines(n.slice(1), closureKinds);
  const reflected = lineCubic.map((cubic) => mapCubic(cubic, ([x, y]) => [12 - x / 2, -8 + y / 2]));
  const reflectedPolygon = B.map(([x, y]) => [12 - x / 2, -8 + y / 2] as const);
  const translatedClosure = closure.map((cubic) => mapCubic(cubic, ([x, y]) => [x + 30, y]));
  const translatedR = R.map(([x, y]) => [x + 30, y] as const);
  const translated = lineCubic.map((cubic) => mapCubic(cubic, ([x, y]) => [x + 3, y + 3]));
  const signedFirst = translated[0]!;
  translated[0] = [[-0, -0], [+0, +0], signedFirst[2], signedFirst[3]];
  const signedLast = translated[7]!;
  translated[7] = [signedLast[0], signedLast[1], signedLast[2], [+0, +0]];
  const signedPolygon = [
    [-0, -0],
    [6, 6],
    [6, 15 / 2],
    [0, 15 / 2],
    [0, 6],
    [6, 0],
    [6, -3 / 2],
    [0, -3 / 2],
  ] as const satisfies readonly Point[];
  return [
    positive(
      'line-cubic',
      [segments(lineCubic, sequentialOrdinals(1, 8))],
      lineCubicKinds,
      [B],
      [{ leftLeaf: 0, rightLeaf: 4, orientation: -1 }],
      8,
      28,
      4,
    ),
    positive(
      'line-line',
      [segments(lineLine, sequentialOrdinals(1, 8))],
      lineLineKinds,
      [B],
      [{ leftLeaf: 0, rightLeaf: 4, orientation: -1 }],
      8,
      28,
      4,
    ),
    positive(
      'line-closure',
      [segments(closure, sequentialOrdinals(1, 7))],
      closureKinds,
      [R],
      [{ leftLeaf: 3, rightLeaf: 7, orientation: 1 }],
      8,
      28,
      22,
    ),
    positive(
      'reflected',
      [segments(reflected, sequentialOrdinals(1, 8))],
      lineCubicKinds,
      [reflectedPolygon],
      [{ leftLeaf: 0, rightLeaf: 4, orientation: 1 }],
      8,
      28,
      4,
    ),
    positive(
      'packed-ordinals',
      [segments(lineCubic, sequentialOrdinals(2, 8))],
      lineCubicKinds,
      [B],
      [{ leftLeaf: 0, rightLeaf: 4, orientation: -1 }],
      8,
      28,
      4,
    ),
    positive(
      'two-closures',
      [
        segments(closure, sequentialOrdinals(1, 7)),
        segments(translatedClosure, sequentialOrdinals(9, 7)),
      ],
      [...closureKinds, ...closureKinds],
      [R, translatedR],
      [
        { leftLeaf: 3, rightLeaf: 7, orientation: 1 },
        { leftLeaf: 11, rightLeaf: 15, orientation: 1 },
      ],
      16,
      120,
      46,
    ),
    positive(
      'marked-signed-zero',
      [segments(translated, sequentialOrdinals(1, 8))],
      lineCubicKinds,
      [signedPolygon],
      [{ leftLeaf: 0, rightLeaf: 4, orientation: -1 }],
      8,
      28,
      4,
    ),
  ];
}

/** Returns the frozen all-LINE multiple-partner rejection. */
export function fixedMixedLineArrangementControl(): MixedLineArrangementControl {
  const cubics = M.map((start, index) => lineAdapter(start, M[(index + 1) % M.length]!));
  return {
    id: 'multiple-partners',
    contours: [segments(cubics, sequentialOrdinals(1, 8))],
    sourceKinds: [true, true, true, true, true, true, true, true],
    leaves: 8,
    pairs: 5,
  };
}
