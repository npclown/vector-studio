// D9 E3 unit E3-U2: builders of canonical A04 cases (contract section 13.2) for the oracle's
// unit tests and controls. Only the fields the oracle reads are filled in.
import type {
  A04Case,
  A04Mesh,
  A04Scalar,
} from '../../../packages/geometry-reference/src/a04-region.js';
import { hex } from './corpus.js';

export type CasePaint =
  | Readonly<{ kind: 'fill'; rule: 'nonzero' | 'evenodd' }>
  | Readonly<{
      kind: 'stroke';
      width: number;
      cap: 'butt' | 'round' | 'square';
      join: 'miter' | 'round' | 'bevel';
      miterLimit: number;
    }>;

export type CaseSpec = Readonly<{
  id?: string;
  verbs: string;
  points: readonly number[];
  paint: CasePaint;
  l?: readonly [number, number, number, number];
  t?: readonly [number, number];
  c?: readonly [number, number];
  zoom?: number;
  dpr?: number;
}>;

export function makeCase(spec: CaseSpec): A04Case {
  const paint =
    spec.paint.kind === 'fill'
      ? { kind: 'fill', rule: spec.paint.rule }
      : {
          cap: spec.paint.cap,
          join: spec.paint.join,
          kind: 'stroke',
          miterLimit: hex(spec.paint.miterLimit),
          width: hex(spec.paint.width),
        };
  return {
    camera: {
      c: (spec.c ?? [0, 0]).map(hex),
      dpr: hex(spec.dpr ?? 1),
      zoom: hex(spec.zoom ?? 1),
    },
    id: spec.id ?? 'test',
    paint,
    path: { points: spec.points.map(hex), verbs: spec.verbs },
    viewport: [640, 360],
    world: { l: (spec.l ?? [1, 0, 0, 1]).map(hex), t: (spec.t ?? [0, 0]).map(hex) },
  };
}

export const fill = (rule: 'nonzero' | 'evenodd' = 'nonzero'): CasePaint => ({
  kind: 'fill',
  rule,
});

export const stroke = (
  width: number,
  cap: 'butt' | 'round' | 'square' = 'butt',
  join: 'miter' | 'round' | 'bevel' = 'miter',
  miterLimit = 4,
): CasePaint => ({ kind: 'stroke', width, cap, join, miterLimit });

/** A closed polygon path. */
export function polygon(points: readonly (readonly [number, number])[]): {
  verbs: string;
  points: number[];
} {
  return { verbs: `M${'L'.repeat(points.length - 1)}Z`, points: points.flat() };
}

/** Several closed polygons in one path. */
export function polygons(list: readonly (readonly (readonly [number, number])[])[]): {
  verbs: string;
  points: number[];
} {
  return list
    .map(polygon)
    .reduce((a, b) => ({ verbs: a.verbs + b.verbs, points: [...a.points, ...b.points] }), {
      verbs: '',
      points: [] as number[],
    });
}

/** An axis rectangle (x0,y0)-(x1,y1), counter-clockwise in y-down... as listed. */
export const rect = (x0: number, y0: number, x1: number, y1: number): [number, number][] => [
  [x0, y0],
  [x1, y0],
  [x1, y1],
  [x0, y1],
];

/** A triangle mesh from triangles given by vertex coordinates. */
export function meshOf(
  triangles: readonly (readonly (readonly [A04Scalar, A04Scalar])[])[],
): A04Mesh {
  const positions: A04Scalar[] = [];
  const indices: number[] = [];
  for (const tri of triangles)
    for (const [x, y] of tri) {
      indices.push(positions.length / 2);
      positions.push(x, y);
    }
  return { positions, indices };
}

/** A fan triangulation of a convex polygon. */
export function fanMesh(points: readonly (readonly [A04Scalar, A04Scalar])[]): A04Mesh {
  const tris: (readonly [A04Scalar, A04Scalar])[][] = [];
  for (let i = 1; i + 1 < points.length; i += 1)
    tris.push([points[0]!, points[i]!, points[i + 1]!]);
  return meshOf(tris);
}

export const EMPTY_MESH: A04Mesh = { positions: [], indices: [] };
