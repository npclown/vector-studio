import type { FillMesh, FillMeshRequest, StrokeMeshRequest } from '@vector-studio/contracts';
import { readFile } from 'node:fs/promises';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  classifyLineFill,
  type LineFillRule,
  type Point,
} from '../../packages/geometry-reference/src/index.js';
import {
  createFillMeshPort,
  createStrokeMeshPort,
} from '../../packages/geometry-wasm/src/index.js';
import {
  FILL_CONFORMANCE_PATHS,
  FILL_REGION_FIXTURES,
} from '../support/fill-mesh-port-conformance.js';
import {
  STROKE_EXACT_FIXTURES,
  STROKE_CONFORMANCE_PATHS,
} from '../support/stroke-mesh-port-conformance.js';

// E39-A7: the production port's winding (fill) and union (stroke) meshes. The shared
// conformance suites check partition meshes and run on the exact rungs; this file checks what
// production draws: the coverage word, no boundary edges, and the covered region sampled
// against the independent oracle (fill) or the exact rung's partition mesh (stroke).

let module: WebAssembly.Module;
beforeAll(async () => {
  if (!process.env.P2_WASM_PATH) throw new Error('Run through pnpm test:geometry');
  module = await WebAssembly.compile(new Uint8Array(await readFile(process.env.P2_WASM_PATH)));
});

const MOVE = 0;
const LINE = 1;
const CLOSE = 3;

/** Grid samples off every integer and half-integer line, so none lies on a fixture edge. */
function samples(minX: number, minY: number, maxX: number, maxY: number): Point[] {
  const points: Point[] = [];
  for (let x = minX + 0.2371; x < maxX; x += 0.5) {
    for (let y = minY + 0.1189; y < maxY; y += 0.5) points.push([x, y]);
  }
  return points;
}

function orient(a: Point, b: Point, c: Point): number {
  return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
}

/** Signed winding of `p` over the mesh triangles, and how many triangles contain it. */
function windingAt(mesh: FillMesh, p: Point): { winding: number; hits: number } {
  let winding = 0;
  let hits = 0;
  const at = (vertex: number): Point => [
    mesh.positions[2 * vertex]!,
    mesh.positions[2 * vertex + 1]!,
  ];
  for (let slot = 0; slot < mesh.indices.length; slot += 3) {
    const [a, b, c] = [
      at(mesh.indices[slot]!),
      at(mesh.indices[slot + 1]!),
      at(mesh.indices[slot + 2]!),
    ];
    const area = orient(a, b, c);
    if (area === 0) continue;
    const sign = Math.sign(area);
    if (sign * orient(a, b, p) > 0 && sign * orient(b, c, p) > 0 && sign * orient(c, a, p) > 0) {
      winding += sign;
      hits += 1;
    }
  }
  return { winding, hits };
}

function contoursOf(fixture: { verbs: readonly number[]; points: readonly number[] }): Point[][] {
  const contours: Point[][] = [];
  let current: Point[] | null = null;
  let scalar = 0;
  for (const verb of fixture.verbs) {
    if (verb === MOVE) {
      current = [[fixture.points[scalar]!, fixture.points[scalar + 1]!]];
      contours.push(current);
      scalar += 2;
    } else if (verb === LINE) {
      current!.push([fixture.points[scalar]!, fixture.points[scalar + 1]!]);
      scalar += 2;
    } else if (verb === CLOSE) {
      current = null;
    }
  }
  return contours;
}

function filled(winding: number, rule: LineFillRule): boolean {
  return rule === 'nonzero' ? winding !== 0 : Math.abs(winding) % 2 === 1;
}

describe('E39 production fill: winding meshes', () => {
  for (const fillRule of ['nonzero', 'evenodd'] as const) {
    it(`samples every region fixture under ${fillRule} like the independent oracle`, async () => {
      const port = await createFillMeshPort(module);
      try {
        const requests: FillMeshRequest[] = FILL_REGION_FIXTURES.map(({ name }, requestId) => ({
          requestId,
          verbs: Uint8Array.from(FILL_CONFORMANCE_PATHS[name].verbs),
          points: Float64Array.from(FILL_CONFORMANCE_PATHS[name].points),
          fillRule,
          toleranceExponent: -3,
        }));
        const batch = port.buildFillMeshes(requests);
        expect(batch.status).toBe('ok');
        if (batch.status !== 'ok') return;
        FILL_REGION_FIXTURES.forEach(({ name, areas }, index) => {
          const result = batch.results[index]!;
          // A fan does not resolve the region, so a zero-area fixture (f04 under evenodd, f05)
          // is an ok mesh whose samples all come out unfilled.
          if (areas[fillRule] === 0 && result.status === 'empty') return;
          expect(result.status, name).toBe('ok');
          if (result.status !== 'ok') return;
          const { mesh } = result;
          expect(mesh.coverage, name).toBe('winding');
          expect(mesh.boundaryEdges, name).toHaveLength(0);
          expect(mesh.servedExponent, name).toBeUndefined();
          const contours = contoursOf(FILL_CONFORMANCE_PATHS[name]);
          for (const p of samples(-6, -1, 11, 11)) {
            const expected = classifyLineFill(contours, p, fillRule) === 'inside';
            expect(filled(windingAt(mesh, p).winding, fillRule), `${name} at ${p.join(',')}`).toBe(
              expected,
            );
          }
        });
      } finally {
        port.dispose();
      }
    });
  }
});

describe('E39 production stroke: union meshes', () => {
  it('covers the same samples as the exact rung on every exact-region fixture', async () => {
    const production = await createStrokeMeshPort(module);
    const exact = await createStrokeMeshPort(module, { exactRungsForTesting: true });
    try {
      const requests: StrokeMeshRequest[] = STROKE_EXACT_FIXTURES.map(
        ({ name, style }, requestId) => ({
          requestId,
          verbs: Uint8Array.from(STROKE_CONFORMANCE_PATHS[name].verbs),
          points: Float64Array.from(STROKE_CONFORMANCE_PATHS[name].points),
          ...style,
          toleranceExponent: -3,
        }),
      );
      const union = production.buildStrokeMeshes(requests);
      const partition = exact.buildStrokeMeshes(requests);
      expect(union.status).toBe('ok');
      expect(partition.status).toBe('ok');
      if (union.status !== 'ok' || partition.status !== 'ok') return;
      STROKE_EXACT_FIXTURES.forEach(({ id }, index) => {
        const left = union.results[index]!;
        const right = partition.results[index]!;
        expect(left.status, id).toBe('ok');
        expect(right.status, id).toBe('ok');
        if (left.status !== 'ok' || right.status !== 'ok') return;
        expect(left.mesh.coverage, id).toBe('union');
        expect(left.mesh.boundaryEdges, id).toHaveLength(0);
        expect(right.mesh.coverage, id).toBeUndefined();
        for (const p of samples(-3, -3, 7, 7)) {
          const covered = windingAt(left.mesh, p).hits > 0;
          const reference = windingAt(right.mesh, p).hits > 0;
          expect(covered, `${id} at ${p.join(',')}`).toBe(reference);
        }
      });
    } finally {
      production.dispose();
      exact.dispose();
    }
  });
});
