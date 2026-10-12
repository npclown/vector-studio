import type { FillMesh } from '@vector-studio/contracts';
import { describe, expect, it } from 'vitest';
import type { Point } from '../../packages/geometry-reference/src/index.js';
import { checkFillMesh, checkFillRegion } from '../support/fill-mesh-check.js';
import { createFillMeshPortDouble } from '../support/fill-mesh-port-double.js';
import { FILL_CONFORMANCE_PATHS } from '../support/fill-mesh-port-conformance.js';

// Positive controls for the independent mesh check (P3 V2 contract, section f).

function mesh(points: readonly Point[], indices: readonly number[], boundary?: number[]): FillMesh {
  const positions = Float64Array.from(points.flat());
  const xs = points.map((point) => point[0]);
  const ys = points.map((point) => point[1]);
  return {
    positions,
    indices: Uint32Array.from(indices),
    boundaryEdges: Uint32Array.from(boundary ?? naiveBoundary(indices)),
    bounds: {
      minX: Math.min(...xs),
      minY: Math.min(...ys),
      maxX: Math.max(...xs),
      maxY: Math.max(...ys),
    },
  };
}

/** Edges used by exactly one triangle, in triangle order: naive counting. */
function naiveBoundary(indices: readonly number[]): number[] {
  const edges: [number, number][] = [];
  for (let slot = 0; slot < indices.length; slot += 3) {
    for (let corner = 0; corner < 3; corner += 1) {
      edges.push([indices[slot + corner]!, indices[slot + ((corner + 1) % 3)]!]);
    }
  }
  return edges
    .filter(
      ([a, b]) =>
        edges.filter(([c, d]) => (a === c && b === d) || (a === d && b === c)).length === 1,
    )
    .flat();
}

const H1_CONTOURS: Point[][] = [
  [
    [0, 0],
    [4, 0],
    [4, 4],
    [0, 4],
  ],
  [
    [4, 1],
    [8, 1],
    [8, 3],
    [4, 3],
  ],
];
const H2_CONTOURS: Point[][] = [
  [
    [0, 0],
    [10, 0],
    [10, 10],
    [0, 10],
  ],
  [
    [-5, 0],
    [0, 0],
    [0, 5],
    [-5, 5],
  ],
];

// The unrefined kernel meshes: two triangles per trapezoid cell.
const H1_UNREFINED = mesh(
  [
    [0, 0],
    [4, 0],
    [4, 4],
    [0, 4],
    [4, 1],
    [8, 1],
    [8, 3],
    [4, 3],
  ],
  [0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7],
);
const H2_UNREFINED = mesh(
  [
    [-5, 0],
    [0, 0],
    [0, 5],
    [-5, 5],
    [10, 0],
    [10, 10],
    [0, 10],
  ],
  [0, 1, 2, 0, 2, 3, 1, 4, 5, 1, 5, 6],
);

function doubleMesh(name: 'h1' | 'h2'): FillMesh {
  const harness = createFillMeshPortDouble();
  const fixture = FILL_CONFORMANCE_PATHS[name];
  const batch = harness.port.buildFillMeshes([
    {
      requestId: 1,
      verbs: Uint8Array.from(fixture.verbs),
      points: Float64Array.from(fixture.points),
      fillRule: 'nonzero',
      toleranceExponent: -3,
    },
  ]);
  if (batch.status !== 'ok' || batch.results[0]?.status !== 'ok') throw new Error('no mesh');
  return batch.results[0].mesh;
}

function withBoundary(source: FillMesh, boundary: readonly number[]): FillMesh {
  return { ...source, boundaryEdges: Uint32Array.from(boundary) };
}

describe('independent fill mesh check', () => {
  it('accepts conforming meshes with the region boundary', () => {
    expect(checkFillMesh(doubleMesh('h1'))).toEqual([]);
    expect(checkFillRegion(doubleMesh('h1'), H1_CONTOURS, 'nonzero', 24)).toEqual([]);
    expect(checkFillMesh(doubleMesh('h2'))).toEqual([]);
    expect(checkFillRegion(doubleMesh('h2'), H2_CONTOURS, 'evenodd', 125)).toEqual([]);
  });

  it('rejects the unrefined kernel meshes of both hanging fixtures for conformity', () => {
    expect(checkFillMesh(H1_UNREFINED).join()).toMatch(/hangs inside edge/u);
    expect(checkFillMesh(H2_UNREFINED).join()).toMatch(/hangs inside edge/u);
  });

  it('rejects a naive edge-count boundary on the unrefined meshes against the region', () => {
    expect(checkFillRegion(H1_UNREFINED, H1_CONTOURS, 'nonzero', 24)).not.toEqual([]);
    expect(checkFillRegion(H2_UNREFINED, H2_CONTOURS, 'nonzero', 125)).not.toEqual([]);
  });

  it('rejects a dropped, duplicated or reversed boundary pair', () => {
    const source = doubleMesh('h1');
    const pairs = Array.from(source.boundaryEdges);
    const dropped = pairs.slice(2);
    const duplicated = [...pairs, pairs[0]!, pairs[1]!];
    const reversed = [pairs[1]!, pairs[0]!, ...pairs.slice(2)];
    for (const boundary of [dropped, duplicated, reversed]) {
      expect(checkFillMesh(withBoundary(source, boundary))).not.toEqual([]);
    }
    expect(checkFillRegion(withBoundary(source, dropped), H1_CONTOURS, 'nonzero', 24)).not.toEqual(
      [],
    );
    expect(checkFillRegion(withBoundary(source, reversed), H1_CONTOURS, 'nonzero', 24)).not.toEqual(
      [],
    );
  });

  it('rejects reversed, overlapping and misbounded triangles and a wrong area', () => {
    const square: Point[] = [
      [0, 0],
      [10, 0],
      [10, 10],
      [0, 10],
    ];
    expect(checkFillMesh(mesh(square, [0, 2, 1, 0, 3, 2])).join()).toMatch(
      /not strictly positive/u,
    );
    expect(checkFillMesh(mesh(square, [0, 1, 2, 0, 2, 3, 0, 1, 3])).join()).toMatch(/overlap/u);
    const shifted = {
      ...mesh(square, [0, 1, 2, 0, 2, 3]),
      bounds: { minX: 0, minY: 0, maxX: 11, maxY: 10 },
    };
    expect(checkFillMesh(shifted).join()).toMatch(/bounds/u);
    expect(checkFillRegion(mesh(square, [0, 1, 2, 0, 2, 3]), [square], 'nonzero', 99)).toEqual([
      'triangle area differs from the oracle area',
    ]);
  });
});
