import { describe, expect, it } from 'vitest';
import {
  classifyLineFill,
  type LineFillLocation,
  type LineFillRule,
  type Point,
} from '../../packages/geometry-reference/src/index.js';

type Contours = readonly (readonly Point[])[];

const square = (minX: number, minY: number, maxX: number, maxY: number): readonly Point[] => [
  [minX, minY],
  [maxX, minY],
  [maxX, maxY],
  [minX, maxY],
];

const reverse = (contour: readonly Point[]): readonly Point[] => [...contour].reverse();

function expectLocation(
  contours: Contours,
  query: Point,
  rule: LineFillRule,
  expected: LineFillLocation,
  fixture = '',
): void {
  expect(classifyLineFill(contours, query, rule), fixture).toBe(expected);
}

function nextUp(value: number): number {
  const bits = new DataView(new ArrayBuffer(8));
  bits.setFloat64(0, value, false);
  bits.setBigUint64(0, bits.getBigUint64(0, false) + 1n, false);
  return bits.getFloat64(0, false);
}

function nextDown(value: number): number {
  const bits = new DataView(new ArrayBuffer(8));
  bits.setFloat64(0, value, false);
  bits.setBigUint64(0, bits.getBigUint64(0, false) - 1n, false);
  return bits.getFloat64(0, false);
}

describe('P3.1a line fill: closed fixture regions (L01, L03)', () => {
  const outer = square(0, 0, 10, 10);
  const inner = square(3, 3, 7, 7);

  it('classifies F01-F07, F09-F11 with literal regions for both fill rules', () => {
    const fixtures: readonly {
      readonly name: string;
      readonly contours: Contours;
      readonly samples: readonly {
        readonly query: Point;
        readonly nonzero: LineFillLocation;
        readonly evenodd: LineFillLocation;
      }[];
    }[] = [
      {
        name: 'F01 outer square',
        contours: [outer],
        samples: [
          { query: [1, 1], nonzero: 'inside', evenodd: 'inside' },
          { query: [11, 1], nonzero: 'outside', evenodd: 'outside' },
          { query: [0, 5], nonzero: 'boundary', evenodd: 'boundary' },
        ],
      },
      {
        name: 'F02 same-oriented inner square',
        contours: [outer, inner],
        samples: [
          { query: [5, 5], nonzero: 'inside', evenodd: 'outside' },
          { query: [3, 5], nonzero: 'inside', evenodd: 'boundary' },
          { query: [1, 1], nonzero: 'inside', evenodd: 'inside' },
          { query: [11, 1], nonzero: 'outside', evenodd: 'outside' },
        ],
      },
      {
        name: 'F03 reversed inner square',
        contours: [outer, reverse(inner)],
        samples: [
          { query: [5, 5], nonzero: 'outside', evenodd: 'outside' },
          { query: [3, 5], nonzero: 'boundary', evenodd: 'boundary' },
          { query: [1, 1], nonzero: 'inside', evenodd: 'inside' },
        ],
      },
      {
        name: 'F04 duplicate same-oriented contours',
        contours: [outer, outer],
        samples: [
          { query: [1, 1], nonzero: 'inside', evenodd: 'outside' },
          { query: [0, 5], nonzero: 'boundary', evenodd: 'outside' },
        ],
      },
      {
        name: 'F05 duplicate opposite contours',
        contours: [outer, reverse(outer)],
        samples: [
          { query: [1, 1], nonzero: 'outside', evenodd: 'outside' },
          { query: [0, 5], nonzero: 'outside', evenodd: 'outside' },
        ],
      },
      {
        name: 'F06 bowtie',
        contours: [
          [
            [0, 0],
            [4, 4],
            [0, 4],
            [4, 0],
          ],
        ],
        samples: [
          { query: [2, 1], nonzero: 'inside', evenodd: 'inside' },
          { query: [2, 2], nonzero: 'boundary', evenodd: 'boundary' },
          { query: [2, 3], nonzero: 'inside', evenodd: 'inside' },
          { query: [5, 2], nonzero: 'outside', evenodd: 'outside' },
        ],
      },
      {
        name: 'F07 adjacent squares',
        contours: [square(0, 0, 2, 2), square(2, 0, 4, 2)],
        samples: [
          { query: [1, 1], nonzero: 'inside', evenodd: 'inside' },
          { query: [2, 1], nonzero: 'inside', evenodd: 'inside' },
          { query: [0, 1], nonzero: 'boundary', evenodd: 'boundary' },
          { query: [5, 1], nonzero: 'outside', evenodd: 'outside' },
        ],
      },
      {
        name: 'F09 repeated point on F01',
        contours: [
          [
            [0, 0],
            [10, 0],
            [10, 10],
            [10, 10],
            [0, 10],
          ],
        ],
        samples: [
          { query: [5, 5], nonzero: 'inside', evenodd: 'inside' },
          { query: [0, 5], nonzero: 'boundary', evenodd: 'boundary' },
        ],
      },
      {
        name: 'F10 overlapping squares',
        contours: [square(0, 0, 4, 4), square(2, 0, 6, 4)],
        samples: [
          { query: [1, 2], nonzero: 'inside', evenodd: 'inside' },
          { query: [3, 2], nonzero: 'inside', evenodd: 'outside' },
          { query: [5, 2], nonzero: 'inside', evenodd: 'inside' },
          { query: [7, 2], nonzero: 'outside', evenodd: 'outside' },
        ],
      },
      {
        name: 'F11 touching squares',
        contours: [square(0, 0, 4, 4), square(2, 4, 6, 8)],
        samples: [
          { query: [3, 3.5], nonzero: 'inside', evenodd: 'inside' },
          { query: [3, 4], nonzero: 'inside', evenodd: 'inside' },
          { query: [3, 4.5], nonzero: 'inside', evenodd: 'inside' },
          { query: [0, 2], nonzero: 'boundary', evenodd: 'boundary' },
          { query: [7, 5], nonzero: 'outside', evenodd: 'outside' },
        ],
      },
    ];

    for (const fixture of fixtures) {
      for (const sample of fixture.samples) {
        expectLocation(fixture.contours, sample.query, 'nonzero', sample.nonzero, fixture.name);
        expectLocation(fixture.contours, sample.query, 'evenodd', sample.evenodd, fixture.name);
        expectLocation(
          [...fixture.contours].reverse(),
          sample.query,
          'nonzero',
          sample.nonzero,
          `${fixture.name}, reversed contour order`,
        );
        expectLocation(
          [...fixture.contours].reverse(),
          sample.query,
          'evenodd',
          sample.evenodd,
          `${fixture.name}, reversed contour order`,
        );
      }
    }

    const f09Permuted: Contours = [
      inner,
      [
        [0, 0],
        [10, 0],
        [10, 10],
        [10, 10],
        [0, 10],
      ],
    ];
    expectLocation(
      f09Permuted,
      [5, 5],
      'nonzero',
      'inside',
      'F09 contour-order permutation of F02',
    );
    expectLocation(
      f09Permuted,
      [5, 5],
      'evenodd',
      'outside',
      'F09 contour-order permutation of F02',
    );

    const reversedOverlap: Contours = [square(0, 0, 4, 4), reverse(square(2, 0, 6, 4))];
    expectLocation(reversedOverlap, [3, 2], 'nonzero', 'outside');
    expectLocation(reversedOverlap, [3, 2], 'evenodd', 'outside');
  });

  it('keeps a vertex where two outer contours only touch as a resolved boundary', () => {
    const touchingAtVertex: Contours = [square(0, 0, 2, 2), square(2, 2, 4, 4)];
    expectLocation(touchingAtVertex, [2, 2], 'nonzero', 'boundary');
    expectLocation(touchingAtVertex, [2, 2], 'evenodd', 'boundary');
  });
});

describe('P3.1a line fill: closure and degenerate regions (L02, L04)', () => {
  it('implicitly closes F08 only for fill classification', () => {
    const openTriangle: Contours = [
      [
        [0, 0],
        [8, 0],
        [0, 8],
      ],
    ];
    const explicitlyClosed: Contours = [
      [
        [0, 0],
        [8, 0],
        [0, 8],
        [0, 0],
      ],
    ];
    for (const contours of [openTriangle, explicitlyClosed]) {
      expectLocation(contours, [1, 1], 'nonzero', 'inside');
      expectLocation(contours, [1, 1], 'evenodd', 'inside');
      expectLocation(contours, [6, 6], 'nonzero', 'outside');
      expectLocation(contours, [6, 6], 'evenodd', 'outside');
      expectLocation(contours, [4, 4], 'nonzero', 'boundary');
      expectLocation(contours, [4, 4], 'evenodd', 'boundary');
      expectLocation(contours, [0, 4], 'nonzero', 'boundary');
      expectLocation(contours, [0, 4], 'evenodd', 'boundary');
      expectLocation(contours, [-1, 1], 'nonzero', 'outside');
      expectLocation(contours, [-1, 1], 'evenodd', 'outside');
    }
  });

  it('does not manufacture a filled region or boundary from empty, isolated, or retraced contours', () => {
    const cases: readonly Contours[] = [
      [],
      [[]],
      [[[4, 5]]],
      [
        [
          [0, 0],
          [2, 0],
          [4, 0],
        ],
      ],
      [
        [
          [0, 0],
          [4, 0],
          [0, 0],
        ],
      ],
      [
        [
          [0, 0],
          [4, 0],
          [4, 0],
          [0, 0],
        ],
      ],
      [
        [
          [-0, -0],
          [0, 0],
        ],
      ],
    ];
    for (const contours of cases) {
      for (const rule of ['nonzero', 'evenodd'] as const) {
        expectLocation(contours, [0, 0], rule, 'outside');
        expectLocation(contours, [2, 0], rule, 'outside');
      }
    }
  });

  it('keeps a retraced spur outside while preserving the boundary of its attached filled region', () => {
    const rectangleWithRetracedSpur: Contours = [
      [
        [0, 0],
        [4, 0],
        [6, 0],
        [4, 0],
        [4, 4],
        [0, 4],
      ],
    ];
    for (const rule of ['nonzero', 'evenodd'] as const) {
      expectLocation(rectangleWithRetracedSpur, [5, 0], rule, 'outside', 'retraced spur');
      expectLocation(rectangleWithRetracedSpur, [4, 0], rule, 'boundary', 'retraced spur');
    }
  });
});

describe('P3.1a line fill: exact represented-number fixtures (L05)', () => {
  it('classifies subnormal and huge finite squares without determinant overflow or epsilon merging', () => {
    const m = Number.MIN_VALUE;
    const subnormalSquare = square(0, 0, 8 * m, 8 * m);
    const hugeSquare = square(-1e300, -1e300, 1e300, 1e300);
    for (const rule of ['nonzero', 'evenodd'] as const) {
      expectLocation([subnormalSquare], [4 * m, 4 * m], rule, 'inside');
      expectLocation([subnormalSquare], [0, 4 * m], rule, 'boundary');
      expectLocation([subnormalSquare], [9 * m, 4 * m], rule, 'outside');
      expectLocation([hugeSquare], [0, 0], rule, 'inside');
      expectLocation([hugeSquare], [-1e300, 0], rule, 'boundary');
      expectLocation([hugeSquare], [1.1e300, 0], rule, 'outside');
    }
    for (const [name, sourceEdge, contours] of [
      ['subnormal', [0, 4 * m] as Point, subnormalSquare],
      ['huge', [-1e300, 0] as Point, hugeSquare],
    ] as const) {
      expectLocation([contours, contours], sourceEdge, 'evenodd', 'outside', `${name} duplicate`);
      expectLocation(
        [contours, reverse(contours)],
        sourceEdge,
        'nonzero',
        'outside',
        `${name} opposite cancellation`,
      );
      expectLocation(
        [contours, reverse(contours)],
        sourceEdge,
        'evenodd',
        'outside',
        `${name} opposite cancellation`,
      );
    }
  });

  it('distinguishes the exact binary64 neighbors of a source edge near x=1', () => {
    const unitEdge = square(1, 0, 2, 2);
    for (const rule of ['nonzero', 'evenodd'] as const) {
      expectLocation([unitEdge], [nextDown(1), 1], rule, 'outside');
      expectLocation([unitEdge], [1, 1], rule, 'boundary');
      expectLocation([unitEdge], [nextUp(1), 1], rule, 'inside');
    }
  });
});

describe('P3.1a line fill: literal dyadic metamorphisms (L06)', () => {
  const source: Contours = [square(0, 0, 8, 8), square(2, 2, 6, 6)];
  const translated: Contours = [square(32, -16, 40, -8), square(34, -14, 38, -10)];
  const doubled: Contours = [square(0, 0, 16, 16), square(4, 4, 12, 12)];
  const halved: Contours = [square(0, 0, 4, 4), square(1, 1, 3, 3)];
  const reflected: Contours = [
    [
      [0, 0],
      [-8, 0],
      [-8, 8],
      [0, 8],
    ],
    [
      [-2, 2],
      [-6, 2],
      [-6, 6],
      [-2, 6],
    ],
  ];

  it('preserves literal classifications through translation, dyadic scaling, reflection, reversal, and permutation', () => {
    const variants: readonly {
      readonly contours: Contours;
      readonly inside: Point;
      readonly hole: Point;
      readonly boundary: Point;
      readonly outside: Point;
    }[] = [
      { contours: source, inside: [1, 1], hole: [4, 4], boundary: [0, 4], outside: [9, 4] },
      {
        contours: translated,
        inside: [33, -15],
        hole: [36, -12],
        boundary: [32, -12],
        outside: [41, -12],
      },
      { contours: doubled, inside: [2, 2], hole: [8, 8], boundary: [0, 8], outside: [18, 8] },
      { contours: halved, inside: [0.5, 0.5], hole: [2, 2], boundary: [0, 2], outside: [4.5, 2] },
      {
        contours: reflected,
        inside: [-1, 1],
        hole: [-4, 4],
        boundary: [-8, 4],
        outside: [-9, 4],
      },
      {
        contours: [reverse(source[0]!), reverse(source[1]!)],
        inside: [1, 1],
        hole: [4, 4],
        boundary: [0, 4],
        outside: [9, 4],
      },
      {
        contours: [source[1]!, source[0]!],
        inside: [1, 1],
        hole: [4, 4],
        boundary: [0, 4],
        outside: [9, 4],
      },
    ];
    for (const variant of variants) {
      expectLocation(variant.contours, variant.inside, 'nonzero', 'inside');
      expectLocation(variant.contours, variant.inside, 'evenodd', 'inside');
      expectLocation(variant.contours, variant.hole, 'nonzero', 'inside');
      expectLocation(variant.contours, variant.hole, 'evenodd', 'outside');
      expectLocation(variant.contours, variant.boundary, 'nonzero', 'boundary');
      expectLocation(variant.contours, variant.boundary, 'evenodd', 'boundary');
      expectLocation(variant.contours, variant.outside, 'nonzero', 'outside');
      expectLocation(variant.contours, variant.outside, 'evenodd', 'outside');
    }
  });

  it('does not mutate the caller-owned contour or point arrays', () => {
    const mutable: [number, number][][] = [
      [
        [0, 0],
        [8, 0],
        [8, 8],
        [0, 8],
      ],
      [
        [2, 2],
        [6, 2],
        [6, 6],
        [2, 6],
      ],
    ];
    const query: [number, number] = [4, 4];
    const before = structuredClone({ mutable, query });
    expectLocation(mutable, query, 'nonzero', 'inside');
    expectLocation(mutable, query, 'evenodd', 'outside');
    expect({ mutable, query }).toEqual(before);
  });
});

describe('P3.1a line fill: validation limits and malformed input (L07)', () => {
  const unsafeClassify = classifyLineFill as unknown as (
    contours: unknown,
    query: unknown,
    rule: unknown,
  ) => unknown;

  it('accepts both inclusive limits and rejects each limit-plus-one case', () => {
    const emptyContours = Array.from({ length: 256 }, () => [] as Point[]);
    const vertices256 = Array.from({ length: 256 }, (_, index) => [index, 0] as Point);
    const contours256Vertices = Array.from(
      { length: 128 },
      () =>
        [
          [0, 0],
          [1, 0],
        ] as const,
    );
    const contours257Vertices = [
      ...Array.from(
        { length: 127 },
        () =>
          [
            [0, 0],
            [1, 0],
          ] as const,
      ),
      [
        [0, 0],
        [1, 0],
        [2, 0],
      ] as const,
    ];
    expectLocation(emptyContours, [0, 0], 'nonzero', 'outside');
    expectLocation([vertices256], [0, 0], 'evenodd', 'outside');
    expectLocation(contours256Vertices, [0, 0], 'evenodd', 'outside');
    expect(() =>
      unsafeClassify(
        Array.from({ length: 257 }, () => []),
        [0, 0],
        'nonzero',
      ),
    ).toThrow(RangeError);
    expect(() =>
      unsafeClassify([Array.from({ length: 257 }, (_, index) => [index, 0])], [0, 0], 'evenodd'),
    ).toThrow(RangeError);
    expect(() =>
      unsafeClassify([Array.from({ length: 257 }, () => [0, 0])], [0, 0], 'nonzero'),
    ).toThrow(RangeError);
    expect(() => unsafeClassify(contours257Vertices, [0, 0], 'evenodd')).toThrow(RangeError);
  });

  it('rejects malformed and nonfinite input, including a late contour after an earlier match', () => {
    const validSquare = square(0, 0, 2, 2);
    const invalidCases: readonly [unknown, unknown, unknown][] = [
      [[validSquare], [1, 1], 'winding'],
      [[validSquare], [Number.NaN, 1], 'nonzero'],
      [[validSquare], [Infinity, 1], 'nonzero'],
      [[validSquare], [-Infinity, 1], 'nonzero'],
      [[validSquare], [1], 'nonzero'],
      [[validSquare], [1, 1, 1], 'nonzero'],
      [[validSquare], 'point', 'nonzero'],
      ['contours', [1, 1], 'nonzero'],
      [[['not-a-point']], [1, 1], 'nonzero'],
      [[[[0, 0, 1]]], [1, 1], 'nonzero'],
      [[[[0, Infinity]]], [1, 1], 'nonzero'],
      [[[[0, -Infinity]]], [1, 1], 'nonzero'],
      [[validSquare, [[Number.NaN, 0]]], [1, 1], 'nonzero'],
    ];
    for (const [contours, query, rule] of invalidCases) {
      expect(() => unsafeClassify(contours, query, rule)).toThrow(RangeError);
    }
  });
});

describe('P3.1a line fill: fixed positive controls (L08)', () => {
  it('rejects each known wrong classification against an independent literal expected region', () => {
    const outer = square(0, 0, 10, 10);
    const inner = square(3, 3, 7, 7);
    const triangle: Contours = [
      [
        [0, 0],
        [8, 0],
        [0, 8],
      ],
    ];
    const adjacent: Contours = [square(0, 0, 2, 2), square(2, 0, 4, 2)];

    const expectedHoleUnderEvenodd: LineFillLocation = 'outside';
    const wrongFillRule = classifyLineFill([outer, inner], [5, 5], 'nonzero');
    expect(wrongFillRule).not.toBe(expectedHoleUnderEvenodd);
    expectLocation([outer, inner], [5, 5], 'evenodd', expectedHoleUnderEvenodd);

    const expectedHoleWithReversedInner: LineFillLocation = 'outside';
    const wrongHoleOmission = classifyLineFill([outer], [5, 5], 'nonzero');
    expect(wrongHoleOmission).not.toBe(expectedHoleWithReversedInner);
    expectLocation([outer, reverse(inner)], [5, 5], 'nonzero', expectedHoleWithReversedInner);

    const expectedImplicitClosureInterior: LineFillLocation = 'inside';
    expectLocation(triangle, [1, 1], 'nonzero', expectedImplicitClosureInterior);
    // A right-ray test that omits the vertical implicit closing edge would call this inside.
    const expectedOutsideBeyondImplicitClosingEdge: LineFillLocation = 'outside';
    const wrongOpenEdgeOnlyAnswer: LineFillLocation = 'inside';
    const observedImplicitClosure = classifyLineFill(triangle, [-1, 1], 'nonzero');
    expect(observedImplicitClosure).toBe(expectedOutsideBeyondImplicitClosingEdge);
    expect(observedImplicitClosure).not.toBe(wrongOpenEdgeOnlyAnswer);

    const expectedCancelledSharedSpan: LineFillLocation = 'inside';
    const wrongSourceEdgeAnswer: LineFillLocation = 'boundary';
    const observedCancelledSharedSpan = classifyLineFill(adjacent, [2, 1], 'evenodd');
    expect(observedCancelledSharedSpan).toBe(expectedCancelledSharedSpan);
    expect(observedCancelledSharedSpan).not.toBe(wrongSourceEdgeAnswer);
  });
});
