import { describe, expect, it } from 'vitest';
import {
  inspectLineFillMesh,
  type LineFillMeshInput,
  type LineFillMeshInspection,
  type LineFillRule,
  type Point,
  type TriangleMeshInput,
} from '../../packages/geometry-reference/src/index.js';

type Contours = readonly (readonly Point[])[];

const inspectMalformed = inspectLineFillMesh as unknown as (input: unknown) => unknown;

const rectangle = (left: number, bottom: number, right: number, top: number): Point[] => [
  [left, bottom],
  [right, bottom],
  [right, top],
  [left, top],
];

const reversed = (contour: readonly Point[]): Point[] => [...contour].reverse();

const boundsFor = (
  rectangles: readonly (readonly [number, number, number, number])[],
): readonly [number, number, number, number] => [
  Math.min(...rectangles.map(([left]) => left)),
  Math.min(...rectangles.map(([, bottom]) => bottom)),
  Math.max(...rectangles.map(([, , right]) => right)),
  Math.max(...rectangles.map(([, , , top]) => top)),
];

// This expands known literal rectangles into their two analytic triangles. It is not a tessellator.
const rectangleMesh = (
  rectangles: readonly (readonly [number, number, number, number])[],
): TriangleMeshInput => {
  const vertices: Point[] = [];
  const indices: number[] = [];
  for (const [left, bottom, right, top] of rectangles) {
    const start = vertices.length;
    vertices.push(...rectangle(left, bottom, right, top));
    indices.push(start, start + 1, start + 2, start, start + 2, start + 3);
  }
  const expectedArea = rectangles.reduce(
    (area, [left, bottom, right, top]) => area + (right - left) * (top - bottom),
    0,
  );
  return { vertices, indices, bounds: boundsFor(rectangles), expectedArea };
};

const triangleMesh = (a: Point, b: Point, c: Point): TriangleMeshInput => ({
  vertices: [a, b, c],
  indices: [0, 1, 2],
  bounds: [
    Math.min(a[0], b[0], c[0]),
    Math.min(a[1], b[1], c[1]),
    Math.max(a[0], b[0], c[0]),
    Math.max(a[1], b[1], c[1]),
  ],
});

const emptyMesh = (): TriangleMeshInput => ({
  vertices: [],
  indices: [],
  bounds: [0, 0, 0, 0],
  expectedArea: 0,
});

const withoutExpectedArea = ({
  vertices,
  indices,
  bounds,
}: TriangleMeshInput): TriangleMeshInput => ({
  vertices,
  indices,
  bounds,
});

const ringMesh = (): TriangleMeshInput => ({
  vertices: [
    [0, 0],
    [10, 0],
    [10, 10],
    [0, 10],
    [3, 3],
    [7, 3],
    [7, 7],
    [3, 7],
  ],
  indices: [0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7],
  bounds: [0, 0, 10, 10],
  expectedArea: 84,
});

const expectInspection = (
  input: LineFillMeshInput,
  valid: boolean,
  issue: LineFillMeshInspection['issue'],
): void => {
  expect(inspectLineFillMesh(input)).toEqual({ valid, issue });
};

const expectPass = (contours: Contours, rule: LineFillRule, mesh: TriangleMeshInput): void => {
  expectInspection({ contours, rule, mesh }, true, null);
};

describe('P3.1c fill-region equality: fixed analytic regions (R01, R02)', () => {
  it('accepts F01-F05 nesting and cancellation carriers for both fill rules', () => {
    const outer = rectangle(0, 0, 10, 10);
    const inner = rectangle(3, 3, 7, 7);
    const solid = rectangleMesh([[0, 0, 10, 10]]);
    const solidOtherDiagonal: TriangleMeshInput = {
      vertices: rectangle(0, 0, 10, 10),
      indices: [0, 1, 3, 1, 2, 3],
      bounds: [0, 0, 10, 10],
      expectedArea: 100,
    };
    for (const rule of ['nonzero', 'evenodd'] as const) {
      expectPass([outer], rule, solid);
      expectPass([outer], rule, solidOtherDiagonal);
      expectPass([outer, reversed(inner)], rule, ringMesh());
      expectPass([outer, outer], rule, rule === 'nonzero' ? solid : emptyMesh());
      expectPass([outer, reversed(outer)], rule, emptyMesh());
    }
    expectPass([outer, inner], 'nonzero', solid);
    expectPass([outer, inner], 'evenodd', ringMesh());
    // Eight source vertices plus eight triangles (24 indices) is the inclusive 32-unit carrier.
    expect(outer.length + inner.length + ringMesh().indices.length).toBe(32);
  });

  it('accepts F06-F11 crossing, adjacency, implicit closure, repetition, overlap, and shared-span regions', () => {
    const bowtie: Point[] = [
      [0, 0],
      [4, 4],
      [0, 4],
      [4, 0],
    ];
    const bowtieMesh: TriangleMeshInput = {
      vertices: [
        [0, 0],
        [4, 0],
        [2, 2],
        [0, 4],
        [4, 4],
      ],
      indices: [0, 1, 2, 3, 2, 4],
      bounds: [0, 0, 4, 4],
      expectedArea: 8,
    };
    const adjacent: Contours = [rectangle(0, 0, 2, 2), rectangle(2, 0, 4, 2)];
    const openTriangle: Contours = [
      [
        [0, 0],
        [8, 0],
        [0, 8],
      ],
    ];
    const repeatedOuter: Point[] = [
      [0, 0],
      [10, 0],
      [10, 10],
      [10, 10],
      [0, 10],
    ];
    const inner = rectangle(3, 3, 7, 7);
    const overlap: Contours = [rectangle(0, 0, 4, 4), rectangle(2, 0, 6, 4)];
    const sharedSpan: Contours = [rectangle(0, 0, 4, 4), rectangle(2, 4, 6, 8)];
    for (const rule of ['nonzero', 'evenodd'] as const) {
      expectPass([bowtie], rule, bowtieMesh);
      expectPass(
        adjacent,
        rule,
        rectangleMesh([
          [0, 0, 2, 2],
          [2, 0, 4, 2],
        ]),
      );
      expectPass(openTriangle, rule, triangleMesh([0, 0], [8, 0], [0, 8]));
      expectPass([repeatedOuter], rule, rectangleMesh([[0, 0, 10, 10]]));
      expectPass(
        [inner, rectangle(0, 0, 10, 10)],
        rule,
        rule === 'nonzero' ? rectangleMesh([[0, 0, 10, 10]]) : ringMesh(),
      );
      expectPass(
        overlap,
        rule,
        rule === 'nonzero'
          ? rectangleMesh([[0, 0, 6, 4]])
          : rectangleMesh([
              [0, 0, 2, 4],
              [4, 0, 6, 4],
            ]),
      );
      expectPass(
        sharedSpan,
        rule,
        rectangleMesh([
          [0, 0, 4, 4],
          [2, 4, 6, 8],
        ]),
      );
    }
    expectPass(
      [overlap[0]!, reversed(overlap[1]!)],
      'nonzero',
      rectangleMesh([
        [0, 0, 2, 4],
        [4, 0, 6, 4],
      ]),
    );
    expectPass(
      [overlap[0]!, reversed(overlap[1]!)],
      'evenodd',
      rectangleMesh([
        [0, 0, 2, 4],
        [4, 0, 6, 4],
      ]),
    );
  });
});

describe('P3.1c fill-region equality: independent negative controls (R03)', () => {
  it('rejects equal-area translations, wrong holes/rules, gaps, and invalid overlapping carriers', () => {
    const outer = rectangle(0, 0, 10, 10);
    const inner = rectangle(3, 3, 7, 7);
    const ring = ringMesh();
    expectPass([outer, inner], 'evenodd', ring);
    expectInspection(
      { contours: [outer], rule: 'nonzero', mesh: rectangleMesh([[100, 0, 110, 10]]) },
      false,
      'REGION_MISMATCH',
    );
    expectInspection(
      { contours: [outer, inner], rule: 'evenodd', mesh: rectangleMesh([[0, 0, 10, 10]]) },
      false,
      'REGION_MISMATCH',
    );
    expectInspection(
      { contours: [outer, inner], rule: 'nonzero', mesh: ring },
      false,
      'REGION_MISMATCH',
    );
    // The gap removes ten units of area while the disjoint extra rectangle restores total area.
    expectInspection(
      {
        contours: [outer],
        rule: 'nonzero',
        mesh: rectangleMesh([
          [0, 0, 9, 10],
          [20, 0, 21, 10],
        ]),
      },
      false,
      'REGION_MISMATCH',
    );
    expectInspection(
      {
        contours: [outer],
        rule: 'nonzero',
        mesh: { ...rectangleMesh([[0, 0, 10, 10]]), indices: [0, 1, 2] },
      },
      false,
      'AREA_MISMATCH',
    );
    const square = rectangleMesh([[0, 0, 10, 10]]);
    expectInspection(
      {
        contours: [outer],
        rule: 'nonzero',
        mesh: { ...square, indices: [...square.indices, 0, 1, 2] },
      },
      false,
      'OVERLAPPING_TRIANGLES',
    );
  });
});

describe('P3.1c fill-region equality: exact binary64 and zero-dimensional cases (R04)', () => {
  it('uses exact events for non-dyadic intersections that cancel to empty', () => {
    const first: Point[] = [
      [0, 0],
      [3, 1],
      [0, 2],
    ];
    const second: Point[] = [
      [1, -1],
      [2, 3],
      [3, -1],
    ];
    for (const rule of ['nonzero', 'evenodd'] as const) {
      expectPass([first, reversed(first), second, reversed(second)], rule, emptyMesh());
    }
  });

  it('keeps represented tiny, subnormal, huge, isolated, and retraced regions exact', () => {
    const m = Number.MIN_VALUE;
    const cases: readonly [Contours, TriangleMeshInput][] = [
      [[rectangle(0, 0, 2 * m, 2 * m)], withoutExpectedArea(rectangleMesh([[0, 0, 2 * m, 2 * m]]))],
      [[rectangle(0, 0, 8 * m, 8 * m)], withoutExpectedArea(rectangleMesh([[0, 0, 8 * m, 8 * m]]))],
      [
        [rectangle(-1e300, -1e300, 1e300, 1e300)],
        withoutExpectedArea(rectangleMesh([[-1e300, -1e300, 1e300, 1e300]])),
      ],
      [[[[-0, -0]]], emptyMesh()],
      [
        [
          [
            [0, 0],
            [2, 0],
            [0, 0],
            [2, 0],
          ],
        ],
        emptyMesh(),
      ],
    ];
    for (const [contours, mesh] of cases) {
      expectPass(contours, 'nonzero', mesh);
      expectPass(contours, 'evenodd', mesh);
    }

    expectInspection(
      {
        contours: [rectangle(0, 0, 8 * m, 8 * m)],
        rule: 'nonzero',
        mesh: withoutExpectedArea(
          rectangleMesh([
            [0, 0, 7 * m, 8 * m],
            [9 * m, 0, 10 * m, 8 * m],
          ]),
        ),
      },
      false,
      'REGION_MISMATCH',
    );
  });
});

describe('P3.1c fill-region equality: literal metamorphisms and ownership (R05)', () => {
  it('preserves translated, scaled, reflected, reversed, and permuted carriers without mutation or state', () => {
    const source = rectangle(0, 0, 2, 2);
    const base: LineFillMeshInput = {
      contours: [source],
      rule: 'nonzero',
      mesh: rectangleMesh([[0, 0, 2, 2]]),
    };
    const before = structuredClone(base);
    expectInspection(base, true, null);
    expect(base).toEqual(before);
    const variants: readonly LineFillMeshInput[] = [
      {
        contours: [rectangle(32, -16, 34, -14)],
        rule: 'nonzero',
        mesh: rectangleMesh([[32, -16, 34, -14]]),
      },
      { contours: [rectangle(0, 0, 4, 4)], rule: 'nonzero', mesh: rectangleMesh([[0, 0, 4, 4]]) },
      {
        contours: [
          [
            [0, 0],
            [-2, 0],
            [-2, 2],
            [0, 2],
          ],
        ],
        rule: 'nonzero',
        mesh: {
          vertices: [
            [0, 0],
            [-2, 0],
            [-2, 2],
            [0, 2],
          ],
          indices: [0, 2, 1, 0, 3, 2],
          bounds: [-2, 0, 0, 2],
          expectedArea: 4,
        },
      },
      { contours: [reversed(source)], rule: 'nonzero', mesh: rectangleMesh([[0, 0, 2, 2]]) },
      {
        contours: [source],
        rule: 'nonzero',
        mesh: { ...rectangleMesh([[0, 0, 2, 2]]), indices: [0, 2, 3, 0, 1, 2] },
      },
      { contours: [[], source], rule: 'nonzero', mesh: rectangleMesh([[0, 0, 2, 2]]) },
    ];
    for (const variant of variants) expectInspection(variant, true, null);
    expectInspection({ ...base, mesh: rectangleMesh([[8, 0, 10, 2]]) }, false, 'REGION_MISMATCH');
    expectInspection(base, true, null);
  });
});

describe('P3.1c fill-region equality: envelope, limits, and ordered failures (R06)', () => {
  it('rejects malformed source envelopes and late malformed source or mesh data before geometry', () => {
    const valid = rectangle(0, 0, 2, 2);
    const invalid: unknown[] = [
      null,
      {},
      { contours: 'contours', rule: 'nonzero', mesh: emptyMesh() },
      { contours: [valid], rule: 'winding', mesh: emptyMesh() },
      { contours: [[['x', 0]]], rule: 'nonzero', mesh: emptyMesh() },
      { contours: [[[0, Number.NaN]]], rule: 'nonzero', mesh: emptyMesh() },
      { contours: [valid, [[Infinity, 0]]], rule: 'nonzero', mesh: emptyMesh() },
      {
        contours: [valid],
        rule: 'nonzero',
        mesh: { vertices: [[0, 0]], indices: [0], bounds: [0, 0, 0, 0] },
      },
    ];
    for (const input of invalid) expect(() => inspectMalformed(input)).toThrow(RangeError);
  });

  it('uses the source and combined bounds inclusively, then reports mesh invariants before region mismatch', () => {
    const vertices32: Point[] = Array.from({ length: 32 }, (_, index) => [index, 0]);
    expectInspection({ contours: [vertices32], rule: 'nonzero', mesh: emptyMesh() }, true, null);
    expectInspection(
      { contours: Array.from({ length: 256 }, () => []), rule: 'evenodd', mesh: emptyMesh() },
      true,
      null,
    );
    expect(() =>
      inspectMalformed({
        contours: Array.from({ length: 257 }, () => []),
        rule: 'evenodd',
        mesh: emptyMesh(),
      }),
    ).toThrow(RangeError);
    expect(() =>
      inspectMalformed({
        contours: [Array.from({ length: 33 }, (_, index) => [index, 0])],
        rule: 'nonzero',
        mesh: emptyMesh(),
      }),
    ).toThrow(RangeError);
    const source30: Point[] = Array.from({ length: 30 }, (_, index) => [index, 0]);
    expect(() =>
      inspectMalformed({
        contours: [source30],
        rule: 'nonzero',
        mesh: triangleMesh([0, 0], [1, 0], [0, 1]),
      }),
    ).toThrow(RangeError);

    const source = rectangle(0, 0, 2, 2);
    const reversedTriangle = triangleMesh([0, 0], [0, 2], [2, 0]);
    expectInspection(
      { contours: [source], rule: 'nonzero', mesh: reversedTriangle },
      false,
      'REVERSED_TRIANGLE',
    );
    expect(() =>
      inspectMalformed({
        contours: [source, [[Number.NaN, 0]]],
        rule: 'nonzero',
        mesh: reversedTriangle,
      }),
    ).toThrow(RangeError);
  });
});
