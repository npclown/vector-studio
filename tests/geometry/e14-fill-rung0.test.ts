import type { FillMesh, FillMeshRequest } from '@vector-studio/contracts';
import { readFile } from 'node:fs/promises';
import { beforeAll, describe, expect, it } from 'vitest';
import { createFillMeshPort } from '../../packages/geometry-wasm/src/index.js';
import { checkMeshStructure } from './p3-exit-sweep/structure.js';

// D9 E14-U1 (docs/plans/d9-e14-fill-rung0-edge-cap-contract.md, section 8): E14-A6, the release
// WASM meshes E14-F2 and E14-F3 through the adapter (rung 0's storage is on the heap, not on the
// WebAssembly stack), and the WASM side of E14-A3 for E14-F1 to E14-F4: each mesh passes the
// independent E11 structure checker (exact positive triangles, no repeated directed edge, the
// boundary edges equal the edges used once, no T-junction, no overlap, and the geometry-reference
// triangle-mesh oracle where its 256-triangle cap allows), and its boundary is one cycle whose
// twice area equals the triangles' twice area. The native fixture table (E14-A2) is
// `e14_fill_rung0_tests.rs`. Functional evidence; precision stays UNVERIFIED until A04.

let module: WebAssembly.Module;
beforeAll(async () => {
  if (!process.env.P2_WASM_PATH) throw new Error('Run through pnpm test:geometry');
  module = await WebAssembly.compile(new Uint8Array(await readFile(process.env.P2_WASM_PATH)));
});

const KAPPA = 0.5522847498;
type Cubic = [number, number, number, number, number, number, number, number];

function quarters(r: number): Cubic[] {
  const k = r * KAPPA;
  return [
    [r, 0, r, k, k, r, 0, r],
    [0, r, -k, r, -r, k, -r, 0],
    [-r, 0, -r, -k, -k, -r, 0, -r],
    [0, -r, k, -r, r, -k, r, 0],
  ];
}

/** De Casteljau at 1/2 with binary64 basic operations, as `e14_fill_rung0_tests.rs` does. */
function halves(c: Cubic): [Cubic, Cubic] {
  const mid = (i: number, j: number, a: number[]) => [
    (a[i]! + a[j]!) * 0.5,
    (a[i + 1]! + a[j + 1]!) * 0.5,
  ];
  const [x01, y01] = mid(0, 2, c);
  const [x12, y12] = mid(2, 4, c);
  const [x23, y23] = mid(4, 6, c);
  const p = [x01!, y01!, x12!, y12!, x23!, y23!];
  const [x012, y012] = mid(0, 2, p);
  const [x123, y123] = mid(2, 4, p);
  const [mx, my] = mid(0, 2, [x012!, y012!, x123!, y123!]);
  return [
    [c[0], c[1], x01!, y01!, x012!, y012!, mx!, my!],
    [mx!, my!, x123!, y123!, x23!, y23!, c[6], c[7]],
  ];
}

function path(requestId: number, cubics: Cubic[]): FillMeshRequest {
  const verbs = [0, ...cubics.map(() => 2), 3];
  const points = [cubics[0]![0], cubics[0]![1], ...cubics.flatMap((c) => c.slice(2))];
  return {
    requestId,
    verbs: new Uint8Array(verbs),
    points: new Float64Array(points),
    fillRule: 'nonzero',
    toleranceExponent: -3,
  };
}

/** E14-F4: each quarter of a circle of radius 2^20 halved four times, 8,192 flat edges. */
function f4(requestId: number): FillMeshRequest {
  let cubics = quarters(1_048_576);
  for (let level = 0; level < 4; level += 1) cubics = cubics.flatMap(halves);
  return path(requestId, cubics);
}

function twiceArea(mesh: FillMesh): number {
  const p = mesh.positions;
  let sum = 0;
  for (let t = 0; t < mesh.indices.length; t += 3) {
    const [a, b, c] = [mesh.indices[t]!, mesh.indices[t + 1]!, mesh.indices[t + 2]!];
    sum += (p[2 * b]! - p[2 * a]!) * (p[2 * c + 1]! - p[2 * a + 1]!);
    sum -= (p[2 * b + 1]! - p[2 * a + 1]!) * (p[2 * c]! - p[2 * a]!);
  }
  return sum;
}

/** The boundary edges form one directed cycle through every vertex; its shoelace sum. */
function boundaryCycleTwiceArea(mesh: FillMesh): number {
  const next = new Map<number, number>();
  for (let e = 0; e < mesh.boundaryEdges.length; e += 2)
    next.set(mesh.boundaryEdges[e]!, mesh.boundaryEdges[e + 1]!);
  const vertices = mesh.positions.length / 2;
  expect(next.size).toBe(vertices);
  const p = mesh.positions;
  let sum = 0;
  let at = mesh.boundaryEdges[0]!;
  for (let step = 0; step < vertices; step += 1) {
    const to = next.get(at)!;
    sum += p[2 * at]! * p[2 * to + 1]! - p[2 * to]! * p[2 * at + 1]!;
    at = to;
  }
  expect(at).toBe(mesh.boundaryEdges[0]);
  return sum;
}

describe('E14-U1 rung 0 over E through the release WASM', () => {
  it('meshes E14-F1 to E14-F4 with valid structure (E14-A3, E14-A6)', async () => {
    const adapter = await createFillMeshPort(module);
    const fixtures: [string, FillMeshRequest, number][] = [
      ['E14-F1', path(1, quarters(512)), 256],
      ['E14-F2', path(2, quarters(2_048)), 512],
      ['E14-F3', path(3, quarters(32_768)), 2_048],
      ['E14-F4', f4(4), 8_192],
    ];
    for (const [name, request, vertices] of fixtures) {
      const batch = adapter.buildFillMeshes([request]);
      expect(batch.status, name).toBe('ok');
      if (batch.status !== 'ok') continue;
      const [result] = batch.results;
      expect(result?.status, name).toBe('ok');
      if (result?.status !== 'ok') continue;
      const mesh = result.mesh;
      expect(mesh.positions.length / 2, name).toBe(vertices);
      // Rung 0 triangulates without Steiner points: n − 2 triangles for one simple contour.
      expect(mesh.indices.length / 3, name).toBe(vertices - 2);
      const report = checkMeshStructure(mesh);
      expect(report.issues, name).toEqual([]);
      expect(report.oracleChecked, name).toBe(vertices <= 256);
      const area = twiceArea(mesh);
      expect(area, name).toBeGreaterThan(0);
      expect(Math.abs(area - boundaryCycleTwiceArea(mesh)) / area, name).toBeLessThan(1e-9);
    }
    adapter.dispose();
  });

  it('keeps work-limit beyond E0 and on a self-crossing path over E', async () => {
    const adapter = await createFillMeshPort(module);
    const circle = (r: number) => path(5, quarters(r));
    const crossing: FillMeshRequest = {
      requestId: 6,
      verbs: new Uint8Array([0, 2, 1, 1, 3]),
      points: new Float64Array([0, 0, 0, 64, 64, 64, 64, 0, 0, -32, 64, -32]),
      fillRule: 'nonzero',
      toleranceExponent: -12,
    };
    const batch = adapter.buildFillMeshes([circle(2_097_152), crossing]);
    expect(batch.status).toBe('ok');
    if (batch.status === 'ok')
      for (const result of batch.results)
        expect(result).toMatchObject({ status: 'failed', code: 'work-limit' });
    adapter.dispose();
  });
});
