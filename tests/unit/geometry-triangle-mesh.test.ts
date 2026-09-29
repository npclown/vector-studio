import { describe, expect, it } from 'vitest';
import {
  inspectTriangleMesh,
  type Point,
  type TriangleMeshInput,
  type TriangleMeshIssue,
} from '../../packages/geometry-reference/src/index.js';

const inspectMalformed = inspectTriangleMesh as unknown as (input: unknown) => unknown;

const unitSquareVertices = (): Point[] => [
  [0, 0],
  [2, 0],
  [2, 2],
  [0, 2],
];

const firstDiagonal = (): TriangleMeshInput => ({
  vertices: unitSquareVertices(),
  indices: [0, 1, 2, 0, 2, 3],
  bounds: [0, 0, 2, 2],
  expectedArea: 4,
});

const expectInspection = (
  input: TriangleMeshInput,
  valid: boolean,
  issue: TriangleMeshIssue | null,
): void => {
  expect(inspectTriangleMesh(input)).toEqual({ valid, issue });
};

const gridWith256DisjointTriangles = (): TriangleMeshInput => {
  const width = 16;
  const height = 8;
  const vertices = Array.from(
    { length: (width + 1) * (height + 1) },
    (_, index) => [index % (width + 1), Math.floor(index / (width + 1))] as Point,
  );
  const indices: number[] = [];
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const lowerLeft = y * (width + 1) + x;
      const lowerRight = lowerLeft + 1;
      const upperLeft = lowerLeft + width + 1;
      const upperRight = upperLeft + 1;
      indices.push(lowerLeft, lowerRight, upperRight, lowerLeft, upperRight, upperLeft);
    }
  }
  return { vertices, indices, bounds: [0, 0, width, height], expectedArea: width * height };
};

describe('P3.1b triangle mesh: literal valid carriers (M01)', () => {
  it('accepts square triangulations for both diagonals, loose bounds, optional exact area, and empty output', () => {
    expectInspection(firstDiagonal(), true, null);
    expectInspection(
      {
        vertices: unitSquareVertices(),
        indices: [0, 1, 3, 1, 2, 3],
        bounds: [0, 0, 2, 2],
        expectedArea: 4,
      },
      true,
      null,
    );
    expectInspection({ ...firstDiagonal(), bounds: [-10, -10, 10, 10] }, true, null);
    const square = firstDiagonal();
    const withoutExpectedArea: TriangleMeshInput = {
      vertices: square.vertices,
      indices: square.indices,
      bounds: square.bounds,
    };
    expectInspection(withoutExpectedArea, true, null);
    expectInspection(
      { vertices: [], indices: [], bounds: [0, 0, 0, 0], expectedArea: 0 },
      true,
      null,
    );
  });
});

describe('P3.1b triangle mesh: structural invariant failures (M02)', () => {
  it('reports missing area, duplicate, contained, and crossing triangles after accepting each unmodified carrier', () => {
    const missingSquareTriangle: TriangleMeshInput = { ...firstDiagonal(), indices: [0, 1, 2] };
    expectInspection(firstDiagonal(), true, null);
    expectInspection(missingSquareTriangle, false, 'AREA_MISMATCH');

    const disjoint: TriangleMeshInput = {
      vertices: [
        [0, 0],
        [1, 0],
        [0, 1],
        [2, 0],
        [3, 0],
        [2, 1],
      ],
      indices: [0, 1, 2, 3, 4, 5],
      bounds: [0, 0, 3, 1],
      expectedArea: 1,
    };
    expectInspection(disjoint, true, null);
    const duplicate: TriangleMeshInput = { ...disjoint, indices: [0, 1, 2, 0, 1, 2] };
    expectInspection(duplicate, false, 'OVERLAPPING_TRIANGLES');

    const contained: TriangleMeshInput = {
      vertices: [
        [0, 0],
        [6, 0],
        [0, 6],
        [1, 1],
        [2, 1],
        [1, 2],
      ],
      indices: [0, 1, 2, 3, 4, 5],
      bounds: [0, 0, 6, 6],
      expectedArea: 18.5,
    };
    expectInspection({ ...contained, indices: [0, 1, 2], expectedArea: 18 }, true, null);
    expectInspection(contained, false, 'OVERLAPPING_TRIANGLES');

    const crossing: TriangleMeshInput = {
      vertices: [
        [0, 0],
        [4, 0],
        [2, 4],
        [0, 3],
        [2, -1],
        [4, 3],
      ],
      indices: [0, 1, 2, 3, 4, 5],
      bounds: [0, -1, 4, 4],
      expectedArea: 16,
    };
    expectInspection({ ...crossing, indices: [0, 1, 2], expectedArea: 8 }, true, null);
    expectInspection(crossing, false, 'OVERLAPPING_TRIANGLES');
  });

  it('reports flipped and collinear triangles before later phases', () => {
    expectInspection(
      {
        vertices: [
          [0, 0],
          [0, 2],
          [2, 0],
        ],
        indices: [0, 1, 2],
        bounds: [0, 0, 2, 2],
      },
      false,
      'REVERSED_TRIANGLE',
    );
    expectInspection(
      {
        vertices: [
          [0, 0],
          [1, 0],
          [2, 0],
        ],
        indices: [0, 1, 2],
        bounds: [0, 0, 2, 0],
      },
      false,
      'DEGENERATE_TRIANGLE',
    );
  });
});

describe('P3.1b triangle mesh: boundary-only contact is not overlap (M03)', () => {
  it('accepts shared edges, shared vertices, partial collinear contacts, and T-junction contacts', () => {
    const carriers: readonly TriangleMeshInput[] = [
      firstDiagonal(),
      {
        vertices: [
          [0, 0],
          [1, 0],
          [0, 1],
          [-1, 0],
          [0, -1],
        ],
        indices: [0, 1, 2, 0, 3, 4],
        bounds: [-1, -1, 1, 1],
        expectedArea: 1,
      },
      {
        vertices: [
          [0, 0],
          [4, 0],
          [0, 4],
          [1, 0],
          [2, -2],
          [3, 0],
        ],
        indices: [0, 1, 2, 3, 4, 5],
        bounds: [0, -2, 4, 4],
        expectedArea: 10,
      },
      {
        vertices: [
          [0, 0],
          [4, 0],
          [0, 4],
          [2, 0],
          [1, -2],
          [3, -2],
        ],
        indices: [0, 1, 2, 3, 4, 5],
        bounds: [0, -2, 4, 4],
        expectedArea: 10,
      },
    ];
    for (const carrier of carriers) expectInspection(carrier, true, null);
  });

  it('rejects a represented subnormal-scale overlap without epsilon merging', () => {
    const m = Number.MIN_VALUE;
    expectInspection(
      {
        vertices: [
          [0, 0],
          [8 * m, 0],
          [0, 8 * m],
          [0, 7 * m],
          [8 * m, -m],
          [8 * m, 7 * m],
        ],
        indices: [0, 1, 2, 3, 4, 5],
        bounds: [0, -m, 8 * m, 8 * m],
      },
      false,
      'OVERLAPPING_TRIANGLES',
    );
  });
});

describe('P3.1b triangle mesh: validation and ordered phases (M04)', () => {
  it('throws RangeError for malformed finite-input envelopes', () => {
    const invalid: unknown[] = [
      null,
      {},
      { vertices: 'vertices', indices: [], bounds: [0, 0, 0, 0] },
      { vertices: [[0]], indices: [], bounds: [0, 0, 0, 0] },
      { vertices: [[0, 0, 0]], indices: [], bounds: [0, 0, 0, 0] },
      { vertices: [[null, 0]], indices: [], bounds: [0, 0, 0, 0] },
      { vertices: [['0', 0]], indices: [], bounds: [0, 0, 0, 0] },
      { vertices: [[Number.NaN, 0]], indices: [], bounds: [0, 0, 0, 0] },
      { vertices: [[Infinity, 0]], indices: [], bounds: [0, 0, 0, 0] },
      { vertices: [[-Infinity, 0]], indices: [], bounds: [0, 0, 0, 0] },
      { vertices: [], indices: [], bounds: [0, 0, 0] },
      { vertices: [], indices: [], bounds: [0, 1, 0, 0] },
      { vertices: [], indices: [], bounds: [1, 0, 0, 1] },
      { vertices: [], indices: [], bounds: [0, 0, Infinity, 1] },
      { vertices: [], indices: [], bounds: 'bounds' },
      { vertices: [], indices: [0], bounds: [0, 0, 0, 0] },
      { vertices: [], indices: 'indices', bounds: [0, 0, 0, 0] },
      { vertices: [[0, 0]], indices: [0, 0, 0.5], bounds: [0, 0, 0, 0] },
      { vertices: [[0, 0]], indices: [-1, 0, 0], bounds: [0, 0, 0, 0] },
      { vertices: [[0, 0]], indices: [1, 0, 0], bounds: [0, 0, 0, 0] },
      { vertices: [], indices: [], bounds: [0, 0, 0, 0], expectedArea: -0.5 },
      { vertices: [], indices: [], bounds: [0, 0, 0, 0], expectedArea: Number.NaN },
      { vertices: [], indices: [], bounds: [0, 0, 0, 0], expectedArea: Infinity },
    ];
    for (const input of invalid) expect(() => inspectMalformed(input)).toThrow(RangeError);
  });

  it('validates all data before selecting the first invariant phase', () => {
    expect(() =>
      inspectMalformed({
        vertices: [
          [0, 0],
          [0, 2],
          [2, 0],
          [Number.NaN, 0],
        ],
        indices: [0, 1, 2],
        bounds: [1, 1, 1, 1],
        expectedArea: 0,
      }),
    ).toThrow(RangeError);
    expect(() =>
      inspectMalformed({
        vertices: [
          [0, 0],
          [0, 2],
          [2, 0],
        ],
        indices: [0, 1, 2, 9, 0, 1],
        bounds: [1, 1, 1, 1],
      }),
    ).toThrow(RangeError);
    expectInspection(
      {
        vertices: [
          [0, 0],
          [1, 0],
          [2, 0],
        ],
        indices: [0, 1, 2],
        bounds: [1, 1, 1, 1],
        expectedArea: 99,
      },
      false,
      'DEGENERATE_TRIANGLE',
    );
    const crossingWithWrongBounds: TriangleMeshInput = {
      vertices: [
        [0, 0],
        [4, 0],
        [2, 4],
        [0, 3],
        [2, -1],
        [4, 3],
      ],
      indices: [0, 1, 2, 3, 4, 5],
      bounds: [0, 0, 4, 4],
      expectedArea: 15,
    };
    expectInspection(crossingWithWrongBounds, false, 'BOUNDS_MISMATCH');
    expectInspection(
      { ...crossingWithWrongBounds, bounds: [0, -1, 4, 4] },
      false,
      'OVERLAPPING_TRIANGLES',
    );
    expectInspection(
      {
        vertices: [
          [0, 0],
          [2, 0],
          [0, 2],
          [3, 3],
        ],
        indices: [0, 1, 2],
        bounds: [0, 0, 2, 2],
        expectedArea: 2,
      },
      false,
      'BOUNDS_MISMATCH',
    );
  });
});

describe('P3.1b triangle mesh: exact represented values, limits, and ownership (M05)', () => {
  it('uses inclusive vertex and triangle limits, then rejects limit-plus-one', () => {
    const vertices256 = Array.from({ length: 256 }, (): Point => [0, 0]);
    expectInspection({ vertices: vertices256, indices: [], bounds: [0, 0, 0, 0] }, true, null);
    expectInspection(gridWith256DisjointTriangles(), true, null);
    const vertices257 = Array.from({ length: 257 }, (): Point => [0, 0]);
    expect(() =>
      inspectTriangleMesh({ vertices: vertices257, indices: [], bounds: [0, 0, 0, 0] }),
    ).toThrow(RangeError);
    expect(() =>
      inspectTriangleMesh({
        vertices: [
          [0, 0],
          [1, 0],
          [0, 1],
        ],
        indices: Array.from({ length: 257 * 3 }, (_, i) => i % 3),
        bounds: [0, 0, 1, 1],
      }),
    ).toThrow(RangeError);
  });

  it('handles signed zero and triangles whose ordinary number determinants underflow or overflow', () => {
    const m = Number.MIN_VALUE;
    expectInspection(
      {
        vertices: [
          [-0, -0],
          [2, 0],
          [0, 2],
        ],
        indices: [0, 1, 2],
        bounds: [-0, -0, 2, 2],
        expectedArea: 2,
      },
      true,
      null,
    );
    expectInspection(
      {
        vertices: [
          [0, 0],
          [8 * m, 0],
          [0, 8 * m],
        ],
        indices: [0, 1, 2],
        bounds: [0, 0, 8 * m, 8 * m],
      },
      true,
      null,
    );
    expectInspection(
      {
        vertices: [
          [-1e300, -1e300],
          [1e300, -1e300],
          [-1e300, 1e300],
        ],
        indices: [0, 1, 2],
        bounds: [-1e300, -1e300, 1e300, 1e300],
      },
      true,
      null,
    );
  });

  it('does not mutate inputs or retain state across calls', () => {
    const input: TriangleMeshInput = {
      vertices: [
        [0, 0],
        [2, 0],
        [2, 2],
        [0, 2],
      ],
      indices: [0, 1, 2, 0, 2, 3],
      bounds: [0, 0, 2, 2],
      expectedArea: 4,
    };
    const before = structuredClone(input);
    expectInspection(input, true, null);
    expect(input).toEqual(before);
    expectInspection({ ...input, expectedArea: 3 }, false, 'AREA_MISMATCH');
    expectInspection(input, true, null);
  });
});

describe('P3.1b triangle mesh: literal metamorphisms and invariant-only boundary (M06)', () => {
  it('keeps translated, dyadically scaled, permuted, and reflected corrected-winding meshes valid', () => {
    const variants: readonly TriangleMeshInput[] = [
      {
        vertices: [
          [32, -16],
          [34, -16],
          [34, -14],
          [32, -14],
        ],
        indices: [0, 1, 2, 0, 2, 3],
        bounds: [32, -16, 34, -14],
        expectedArea: 4,
      },
      {
        vertices: [
          [0, 0],
          [4, 0],
          [4, 4],
          [0, 4],
        ],
        indices: [0, 1, 2, 0, 2, 3],
        bounds: [0, 0, 4, 4],
        expectedArea: 16,
      },
      { ...firstDiagonal(), indices: [0, 2, 3, 0, 1, 2] },
      {
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
    ];
    for (const variant of variants) expectInspection(variant, true, null);
  });

  it('rejects deliberately wrong bounds and exact area after geometry is otherwise valid', () => {
    expectInspection({ ...firstDiagonal(), bounds: [0, 0, 1, 2] }, false, 'BOUNDS_MISMATCH');
    expectInspection({ ...firstDiagonal(), expectedArea: 4.5 }, false, 'AREA_MISMATCH');
  });

  it('documents the invariant-only limitation: a translated same-area mesh is valid but covers the wrong region', () => {
    const translatedSameArea: TriangleMeshInput = {
      vertices: [
        [100, 100],
        [102, 100],
        [102, 102],
        [100, 102],
      ],
      indices: [0, 1, 2, 0, 2, 3],
      bounds: [100, 100, 102, 102],
      expectedArea: 4,
    };
    expectInspection(translatedSameArea, true, null);
  });
});
