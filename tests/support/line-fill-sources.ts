// The 32 frozen line-fill source/rule cases of P3.2d (docs/plans/p3-line-fill-mesh-contract.md):
// F01-F11 with the F09 and F10 variants and three globally reversed sources, under both rules.
// Shared by the native bridge (tests/geometry/line-fill.test.ts) and the A02 run of the same
// sources through the release fill-v0 port (tests/geometry/a02-fill-rules-port.test.ts).
import type { LineFillRule, Point } from '../../packages/geometry-reference/src/index.js';

export type LineFillSourceCase = Readonly<{
  id: string;
  contours: readonly (readonly Point[])[];
  areas: Readonly<Record<LineFillRule, number>>;
}>;

export const LINE_FILL_RULES = ['nonzero', 'evenodd'] as const;

const rectangle = (left: number, bottom: number, right: number, top: number): Point[] => [
  [left, bottom],
  [right, bottom],
  [right, top],
  [left, top],
];

const reverse = (contour: readonly Point[]): Point[] => [...contour].reverse();

const outer = rectangle(0, 0, 10, 10);
const inner = rectangle(3, 3, 7, 7);
const squareA = rectangle(0, 0, 4, 4);
const overlapB = rectangle(2, 0, 6, 4);
const sharedB = rectangle(2, 4, 6, 8);
const bowtie: Point[] = [
  [0, 0],
  [4, 4],
  [0, 4],
  [4, 0],
];

export const LINE_FILL_SOURCES: readonly LineFillSourceCase[] = [
  { id: 'F01', contours: [outer], areas: { nonzero: 100, evenodd: 100 } },
  { id: 'F02', contours: [outer, inner], areas: { nonzero: 100, evenodd: 84 } },
  { id: 'F03', contours: [outer, reverse(inner)], areas: { nonzero: 84, evenodd: 84 } },
  { id: 'F04', contours: [outer, outer], areas: { nonzero: 100, evenodd: 0 } },
  { id: 'F05', contours: [outer, reverse(outer)], areas: { nonzero: 0, evenodd: 0 } },
  { id: 'F06', contours: [bowtie], areas: { nonzero: 8, evenodd: 8 } },
  {
    id: 'F07',
    contours: [rectangle(0, 0, 2, 2), rectangle(2, 0, 4, 2)],
    areas: { nonzero: 8, evenodd: 8 },
  },
  {
    id: 'F08',
    contours: [
      [
        [0, 0],
        [8, 0],
        [0, 8],
      ],
    ],
    areas: { nonzero: 32, evenodd: 32 },
  },
  {
    id: 'F09-repeat',
    contours: [
      [
        [0, 0],
        [10, 0],
        [10, 10],
        [10, 10],
        [0, 10],
      ],
    ],
    areas: { nonzero: 100, evenodd: 100 },
  },
  {
    id: 'F09-permuted',
    contours: [inner, outer],
    areas: { nonzero: 100, evenodd: 84 },
  },
  { id: 'F10', contours: [squareA, overlapB], areas: { nonzero: 24, evenodd: 16 } },
  {
    id: 'F10-reversed',
    contours: [squareA, reverse(overlapB)],
    areas: { nonzero: 16, evenodd: 16 },
  },
  { id: 'F11', contours: [squareA, sharedB], areas: { nonzero: 32, evenodd: 32 } },
  {
    id: 'F03-global-reversed',
    contours: [reverse(outer), inner],
    areas: { nonzero: 84, evenodd: 84 },
  },
  {
    id: 'F06-global-reversed',
    contours: [reverse(bowtie)],
    areas: { nonzero: 8, evenodd: 8 },
  },
  {
    id: 'F10-global-reversed',
    contours: [reverse(squareA), reverse(overlapB)],
    areas: { nonzero: 24, evenodd: 16 },
  },
];
