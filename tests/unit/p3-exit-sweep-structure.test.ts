// D9 E11 unit E11-U2: the A01 structure checker, its seeded controls and the stress scene,
// without the WASM build. The sweep over the release WASM runs through `pnpm p3-exit:sweep`.
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import type { FillMesh } from '../../packages/contracts/src/geometry.js';
import {
  STRESS_CUBICS,
  STRESS_PATHS,
  stressPath,
  stressScene,
} from '../geometry/p3-exit-sweep/scene.js';
import { checkMeshStructure, orientation } from '../geometry/p3-exit-sweep/structure.js';
import { runSeededControls, runSweep } from '../geometry/p3-exit-sweep/sweep.js';

/** A 2×1 rectangle as two CCW triangles, its four boundary edges oriented with the region. */
function rectangle(): FillMesh {
  return {
    positions: new Float64Array([0, 0, 2, 0, 2, 1, 0, 1]),
    indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
    boundaryEdges: new Uint32Array([0, 1, 1, 2, 2, 3, 3, 0]),
    bounds: { minX: 0, minY: 0, maxX: 2, maxY: 1 },
  };
}

describe('checkMeshStructure', () => {
  it('accepts a valid mesh and cross-checks it with the reference oracle', () => {
    const report = checkMeshStructure(rectangle());
    expect(report.issues).toEqual([]);
    expect(report.oracleChecked).toBe(true);
    expect(report.triangles).toBe(2);
  });

  it('matches boundary edges by exact position, so a split shared vertex is not a seam', () => {
    // Vertex 4 repeats vertex 2's position: the diagonal is still shared.
    const mesh: FillMesh = {
      ...rectangle(),
      positions: new Float64Array([0, 0, 2, 0, 2, 1, 0, 1, 2, 1]),
      indices: new Uint32Array([0, 1, 2, 0, 4, 3]),
    };
    const report = checkMeshStructure(mesh);
    expect(report.issues).toEqual([]);
    expect(report.duplicatePositions).toBe(1);
  });

  it('fails a T-junction as a boundary mismatch', () => {
    // Right half split at (2, 0.5) on one side only: the long edge (2,0)-(2,1) is unmatched.
    const mesh: FillMesh = {
      positions: new Float64Array([0, 0, 2, 0, 2, 1, 0, 1, 4, 0, 4, 1, 2, 0.5]),
      indices: new Uint32Array([0, 1, 2, 0, 2, 3, 1, 4, 6, 6, 4, 5, 6, 5, 2]),
      boundaryEdges: new Uint32Array([0, 1, 1, 4, 4, 5, 5, 2, 2, 3, 3, 0]),
      bounds: { minX: 0, minY: 0, maxX: 4, maxY: 1 },
    };
    expect(checkMeshStructure(mesh).issues).toContain('BOUNDARY_MISMATCH');
  });

  it('reports an overlap that shares no edge through the reference oracle', () => {
    const mesh: FillMesh = {
      positions: new Float64Array([0, 0, 4, 0, 0, 4, 1, 1, 5, 1, 1, 5]),
      indices: new Uint32Array([0, 1, 2, 3, 4, 5]),
      boundaryEdges: new Uint32Array([0, 1, 1, 2, 2, 0, 3, 4, 4, 5, 5, 3]),
      bounds: { minX: 0, minY: 0, maxX: 5, maxY: 5 },
    };
    expect(checkMeshStructure(mesh).issues).toContain('OVERLAPPING_TRIANGLES');
  });

  it('decides orientation exactly where Float64 rounding cannot', () => {
    // Collinear to within one ulp: the exact sign is positive, the naive product rounds to 0.
    const tiny = 2 ** -52;
    expect(orientation(0, 0, 1, 1, 0.5, 0.5 + tiny)).toBe(1);
    expect(orientation(0, 0, 1, 1, 0.5, 0.5)).toBe(0);
    expect(orientation(0, 0, 1, 1, 0.5, 0.5 - tiny)).toBe(-1);
    expect(orientation(1e300, 1e300, -1e300, 1e300, 0, -1e300)).toBe(1);
  });

  it('catches every seeded control', () => {
    const results = runSeededControls(rectangle());
    expect(results.length).toBe(8);
    expect(results.filter((r) => !r.caught)).toEqual([]);
  });
});

describe('the stress scene', () => {
  it('has the prototype plan size: 1,000 closed paths of 32 cubics', () => {
    const scene = stressScene();
    expect(scene.length).toBe(STRESS_PATHS);
    for (const p of scene) {
      expect(p.verbs.length).toBe(STRESS_CUBICS + 2);
      expect(Array.from(p.verbs.subarray(1, -1)).every((v) => v === 2)).toBe(true);
      expect(p.verbs.at(-1)).toBe(3);
      expect(p.points.length).toBe(2 + 6 * STRESS_CUBICS);
      expect(p.points.every(Number.isFinite)).toBe(true);
    }
    const zooms = scene.map((p) => p.zoom);
    expect(Math.min(...zooms)).toBeGreaterThanOrEqual(2 ** -6.64);
    expect(Math.max(...zooms)).toBeLessThanOrEqual(2 ** 6);
  });

  it('is deterministic and pinned', () => {
    const h = createHash('sha256');
    for (const p of stressScene()) {
      h.update(new Uint8Array(p.points.buffer));
      h.update(`${p.fillRule}${p.toleranceExponent}${JSON.stringify(p.stroke)}`);
    }
    // Changing this value is a new scene version (scene.ts header).
    expect(h.digest('hex')).toBe(SCENE_DIGEST);
    expect(stressPath(7).points).toEqual(stressPath(7).points);
  });
});

describe('runSweep', () => {
  it('flags an outcome that depends on the batch, a broken mesh and a wrong echo', () => {
    let calls = 0;
    const fill = {
      portVersion: 0 as const,
      operationId: 'test/fill',
      buildFillMeshes(requests: readonly { requestId: number; toleranceExponent: number }[]) {
        calls += 1;
        return {
          status: 'ok' as const,
          // The tolerance exponent names the item: 0 is empty only inside a batch, 1 echoes a
          // wrong requestId, 2 returns a mesh with wrong bounds.
          results: requests.map((r) =>
            r.toleranceExponent === 0 && requests.length > 1
              ? {
                  requestId: r.requestId,
                  toleranceExponent: r.toleranceExponent,
                  status: 'empty' as const,
                }
              : r.toleranceExponent === 1
                ? {
                    requestId: r.requestId + 7,
                    toleranceExponent: r.toleranceExponent,
                    status: 'empty' as const,
                  }
                : {
                    requestId: r.requestId,
                    toleranceExponent: r.toleranceExponent,
                    status: 'ok' as const,
                    mesh: { ...rectangle(), bounds: { minX: 0, minY: 0, maxX: 9, maxY: 1 } },
                  },
          ),
        };
      },
    };
    const stroke = {
      portVersion: 0 as const,
      operationId: 'test/stroke',
      buildStrokeMeshes: () => ({
        status: 'batch-failed' as const,
        code: 'internal-error' as const,
      }),
    };
    const p = stressPath(0);
    const request = (toleranceExponent: number) => ({
      verbs: p.verbs,
      points: p.points,
      fillRule: p.fillRule,
      toleranceExponent,
    });
    const result = runSweep({ fill, stroke }, [
      { id: 'a', kind: 'fill', request: request(0) },
      { id: 'b', kind: 'fill', request: request(1) },
      { id: 'c', kind: 'fill', request: request(2) },
    ]);
    expect(calls).toBe(4);
    expect(result.isolationFailures.map((f) => f.id)).toEqual(['a']);
    expect(result.echoFailures).toEqual(['b']);
    expect(result.structureFailures).toEqual([{ id: 'c', issues: ['BOUNDS_NOT_EXACT'] }]);
  });
});

const SCENE_DIGEST = '2201f85e19f88cc305a599d1373134c039f9a8cea3899cd2cfecb519398b3ece';
