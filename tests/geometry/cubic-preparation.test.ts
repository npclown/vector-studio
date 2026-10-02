import { describe, expect, it } from 'vitest';
import type {
  Cubic,
  Point,
  ReferenceFlattenedLine,
} from '../../packages/geometry-reference/src/types.js';
import {
  inspectCubicPreparation,
  type CubicPreparationResult,
  type CubicTopologySegment,
} from './simple-cubic-topology/oracle.js';

function straightCubic(startX: number): Cubic {
  return [
    [startX, 0],
    [startX + 1, 0],
    [startX + 2, 0],
    [startX + 3, 0],
  ];
}

function uniformLines(
  startX: number,
  depth: number,
  sourceVerbOrdinal: number,
): readonly ReferenceFlattenedLine[] {
  const denominator = 2 ** depth;
  return Array.from({ length: denominator }, (_, index) => {
    const numerator = index + 1;
    return {
      end: [startX + (3 * numerator) / denominator, 0],
      provenance: { sourceVerbOrdinal, endNumerator: numerator, depth },
    };
  });
}

function straightSegment(
  index: number,
  depth = 0,
  sourceVerbOrdinal = index + 7,
): CubicTopologySegment {
  const startX = index * 3;
  return {
    cubic: straightCubic(startX),
    sourceVerbOrdinal,
    lines: uniformLines(startX, depth, sourceVerbOrdinal),
  };
}

function finding(result: CubicPreparationResult): NonNullable<CubicPreparationResult['finding']> {
  if (result.finding === null) throw new Error('expected a preparation finding');
  return result.finding;
}

const prepared = { status: 'PREPARED', finding: null } as const satisfies CubicPreparationResult;

describe('P3.2m cubic preparation inspector', () => {
  it('prepares exactly 32 connected cubics and 4096 exact depth-seven leaves', () => {
    const segments = Array.from({ length: 32 }, (_, index) => straightSegment(index, 7));

    expect(inspectCubicPreparation(segments)).toEqual(prepared);
    expect(segments).toHaveLength(32);
    expect(segments.reduce((total, segment) => total + segment.lines.length, 0)).toBe(4096);
  });

  it('accepts a complete dyadic partition reaching the exact depth-20 ceiling', () => {
    const sourceVerbOrdinal = 19;
    const intervals = [
      { endNumerator: 1, depth: 20 },
      ...Array.from({ length: 20 }, (_, index) => ({
        endNumerator: 2,
        depth: 20 - index,
      })),
    ];
    const segment: CubicTopologySegment = {
      cubic: straightCubic(0),
      sourceVerbOrdinal,
      lines: intervals.map(({ endNumerator, depth }) => ({
        end: [(3 * endNumerator) / 2 ** depth, 0],
        provenance: { sourceVerbOrdinal, endNumerator, depth },
      })),
    };

    expect(inspectCubicPreparation([segment])).toEqual(prepared);
    expect(segment.lines).toHaveLength(21);
  });

  it('applies source and line caps before inspecting malformed excess contents', () => {
    const exactBoundary = Array.from({ length: 32 }, (_, index) => straightSegment(index, 7));
    const thirtyThird = [...exactBoundary, undefined as unknown as CubicTopologySegment];
    const sourceResult = inspectCubicPreparation(thirtyThird);
    expect(sourceResult.status).toBe('WORK_LIMIT');
    expect(finding(sourceResult)).toEqual({
      code: 'SOURCE_CAP',
      segmentIndex: 32,
      sourceVerbOrdinal: null,
      lineIndex: null,
      endpoint: null,
    });

    const lineOverflow = exactBoundary.map((segment, segmentIndex) =>
      segmentIndex === 31
        ? {
            ...segment,
            lines: [...segment.lines, undefined as unknown as ReferenceFlattenedLine],
          }
        : segment,
    );
    const lineResult = inspectCubicPreparation(lineOverflow);
    expect(lineResult.status).toBe('WORK_LIMIT');
    expect(finding(lineResult)).toEqual({
      code: 'LINE_CAP',
      segmentIndex: 31,
      sourceVerbOrdinal: null,
      lineIndex: 128,
      endpoint: null,
    });
  });

  it('reports malformed contour, segment, line, numeric, ordinal, and connectivity inputs', () => {
    const sparseSegments = new Array<CubicTopologySegment>(1);
    const sparseLines = new Array<ReferenceFlattenedLine>(1);
    const cases: readonly Readonly<{
      segments: readonly CubicTopologySegment[];
      code: string;
      segmentIndex: number | null;
      lineIndex: number | null;
    }>[] = [
      {
        segments: [] as readonly CubicTopologySegment[],
        code: 'CONTOUR_SHAPE',
        segmentIndex: null,
        lineIndex: null,
      },
      { segments: sparseSegments, code: 'SEGMENT_SHAPE', segmentIndex: 0, lineIndex: null },
      {
        segments: [{ ...straightSegment(0), lines: [] }],
        code: 'LINE_SHAPE',
        segmentIndex: 0,
        lineIndex: null,
      },
      {
        segments: [{ ...straightSegment(0), lines: sparseLines }],
        code: 'LINE_SHAPE',
        segmentIndex: 0,
        lineIndex: 0,
      },
      {
        segments: [
          {
            ...straightSegment(0),
            cubic: [
              [0, 0],
              [1, 0],
              [2, Number.POSITIVE_INFINITY],
              [3, 0],
            ],
          },
        ],
        code: 'CUBIC',
        segmentIndex: 0,
        lineIndex: null,
      },
      {
        segments: [
          {
            ...straightSegment(0),
            lines: [
              {
                ...straightSegment(0).lines[0]!,
                end: [Number.NaN, 0],
              },
            ],
          },
        ],
        code: 'ENDPOINT',
        segmentIndex: 0,
        lineIndex: 0,
      },
      {
        segments: [{ ...straightSegment(0), sourceVerbOrdinal: -1 }],
        code: 'ORDINAL',
        segmentIndex: 0,
        lineIndex: null,
      },
      {
        segments: [straightSegment(0), straightSegment(0, 0, 99)],
        code: 'CONNECTIVITY',
        segmentIndex: 1,
        lineIndex: null,
      },
    ];

    for (const control of cases) {
      const result = inspectCubicPreparation(control.segments);
      expect(result.status).toBe('INVALID_INPUT');
      expect(finding(result)).toMatchObject({
        code: control.code,
        segmentIndex: control.segmentIndex,
        lineIndex: control.lineIndex,
      });
    }
  });

  it('rejects incomplete, malformed, and over-depth provenance before knot checks', () => {
    const base = straightSegment(0);
    const controls = [
      {
        ...base,
        lines: [
          {
            end: [99, 0] as Point,
            provenance: {
              sourceVerbOrdinal: base.sourceVerbOrdinal + 1,
              endNumerator: 1,
              depth: 0,
            },
          },
        ],
      },
      {
        ...base,
        lines: [
          {
            end: [3 / 2 ** 21, 0] as Point,
            provenance: { sourceVerbOrdinal: base.sourceVerbOrdinal, endNumerator: 1, depth: 21 },
          },
        ],
      },
      {
        ...base,
        lines: [
          {
            end: [1.5, 0] as Point,
            provenance: { sourceVerbOrdinal: base.sourceVerbOrdinal, endNumerator: 1, depth: 1 },
          },
        ],
      },
    ];

    for (const control of controls) {
      const result = inspectCubicPreparation([control]);
      expect(result.status).toBe('INVALID_PROVENANCE');
      expect(finding(result)).toMatchObject({
        code: 'PROVENANCE',
        segmentIndex: 0,
        sourceVerbOrdinal: base.sourceVerbOrdinal,
        lineIndex: 0,
        endpoint: null,
      });
    }
  });

  it('rejects a duplicate ordinal across otherwise connected finite sources', () => {
    const first = straightSegment(0, 0, 71);
    const duplicate = straightSegment(1, 0, 71);

    const result = inspectCubicPreparation([first, duplicate]);
    expect(result.status).toBe('INVALID_INPUT');
    expect(finding(result)).toEqual({
      code: 'ORDINAL',
      segmentIndex: 1,
      sourceVerbOrdinal: 71,
      lineIndex: null,
      endpoint: null,
    });
  });

  it('checks all provenance before an earlier knot mismatch', () => {
    const earlierMismatch = {
      ...straightSegment(0, 0, 80),
      lines: [
        {
          end: [4, 0] as Point,
          provenance: { sourceVerbOrdinal: 80, endNumerator: 1, depth: 0 },
        },
      ],
    };
    const laterInvalidProvenance = {
      ...straightSegment(1, 0, 81),
      lines: [
        {
          end: [6, 0] as Point,
          provenance: { sourceVerbOrdinal: 999, endNumerator: 1, depth: 0 },
        },
      ],
    };

    const result = inspectCubicPreparation([earlierMismatch, laterInvalidProvenance]);
    expect(result.status).toBe('INVALID_PROVENANCE');
    expect(finding(result)).toEqual({
      code: 'PROVENANCE',
      segmentIndex: 1,
      sourceVerbOrdinal: 81,
      lineIndex: 0,
      endpoint: null,
    });
  });

  it('checks every exact knot before considering an earlier projection failure', () => {
    const firstOrdinal = 40;
    const secondOrdinal = 41;
    const negativeProjection: CubicTopologySegment = {
      cubic: [
        [0, 0],
        [2 / 128, 0],
        [-1 / 128, 0],
        [1 / 128, 0],
      ],
      sourceVerbOrdinal: firstOrdinal,
      lines: [
        {
          end: [1 / 128, 0],
          provenance: { sourceVerbOrdinal: firstOrdinal, endNumerator: 1, depth: 0 },
        },
      ],
    };
    const connectedStart = 1 / 128;
    const laterMismatch: CubicTopologySegment = {
      cubic: straightCubic(connectedStart),
      sourceVerbOrdinal: secondOrdinal,
      lines: [
        {
          end: [connectedStart + 4, 0],
          provenance: { sourceVerbOrdinal: secondOrdinal, endNumerator: 1, depth: 0 },
        },
      ],
    };

    const result = inspectCubicPreparation([negativeProjection, laterMismatch]);
    expect(result.status).toBe('KNOT_MISMATCH');
    expect(finding(result)).toEqual({
      code: 'KNOT',
      segmentIndex: 1,
      sourceVerbOrdinal: secondOrdinal,
      lineIndex: 0,
      endpoint: 'end',
    });
  });

  it('reports an isolated negative projection without making a topology claim', () => {
    const sourceVerbOrdinal = 52;
    const segment: CubicTopologySegment = {
      cubic: [
        [0, 0],
        [2 / 128, 0],
        [-1 / 128, 0],
        [1 / 128, 0],
      ],
      sourceVerbOrdinal,
      lines: [
        {
          end: [1 / 128, 0],
          provenance: { sourceVerbOrdinal, endNumerator: 1, depth: 0 },
        },
      ],
    };

    const result = inspectCubicPreparation([segment]);
    expect(result.status).toBe('PROJECTION_UNRESOLVED');
    expect(finding(result)).toEqual({
      code: 'PROJECTION',
      segmentIndex: 0,
      sourceVerbOrdinal,
      lineIndex: 0,
      endpoint: null,
    });
    expect(Object.keys(result).sort()).toEqual(['finding', 'status']);
  });

  it('reports an exact constant cubic as a zero-chord projection failure', () => {
    const sourceVerbOrdinal = 61;
    const point = [1, -2] as const;
    const segment: CubicTopologySegment = {
      cubic: [point, point, point, point],
      sourceVerbOrdinal,
      lines: [
        {
          end: point,
          provenance: { sourceVerbOrdinal, endNumerator: 1, depth: 0 },
        },
      ],
    };

    const result = inspectCubicPreparation([segment]);
    expect(result.status).toBe('PROJECTION_UNRESOLVED');
    expect(finding(result)).toEqual({
      code: 'PROJECTION',
      segmentIndex: 0,
      sourceVerbOrdinal,
      lineIndex: 0,
      endpoint: null,
    });
  });

  it('is deterministic, does not mutate inputs, and does not retain caller data', () => {
    const segments = [straightSegment(0, 2)] as CubicTopologySegment[];
    const before = structuredClone(segments);

    const first = inspectCubicPreparation(segments);
    const second = inspectCubicPreparation(segments);
    expect(first).toEqual(prepared);
    expect(second).toEqual(first);
    expect(segments).toEqual(before);

    const mutableEnd = segments[0]!.lines[0]!.end as [number, number];
    mutableEnd[0] = 99;
    segments.push(straightSegment(1));
    expect(first).toEqual(prepared);
  });
});
