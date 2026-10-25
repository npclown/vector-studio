import { readFile } from 'node:fs/promises';
import { beforeAll, describe, expect, it } from 'vitest';

import type { FillMesh } from '../../packages/contracts/src/geometry.js';
import {
  inspectLineFillMesh,
  type TriangleMeshInput,
} from '../../packages/geometry-reference/src/index.js';
import { createFillMeshPort } from '../../packages/geometry-wasm/src/index.js';
import { checkFillMesh, checkFillRegion } from '../support/fill-mesh-check.js';
import { LINE_FILL_RULES, LINE_FILL_SOURCES } from '../support/line-fill-sources.js';

// P3 exit A02 (docs/plans/d9-e11-p3-c03-c05-closure-contract.md, section 7): the 32 line-fill
// source/rule cases (F01-F11 with the F09 and F10 variants and three globally reversed sources)
// through the release fill-v0 port, so A02 is shown on the shipped operation and not only on the
// native line-fill rung (tests/geometry/line-fill.test.ts). Each `ok` mesh must pass the V2
// section f checks, the independent fill-region oracle's exact area and boundary check, and the
// complete region equality of the line-fill oracle; a case of area 0 must be `empty`.
// Precision stays UNVERIFIED until A04 evidence.

const REGION_EXPONENT = -3;
const MOVE = 0;
const LINE = 1;
const CLOSE = 3;

let module: WebAssembly.Module;
beforeAll(async () => {
  if (!process.env.P2_WASM_PATH) throw new Error('Run through pnpm test:geometry');
  module = await WebAssembly.compile(new Uint8Array(await readFile(process.env.P2_WASM_PATH)));
});

function triangleInput(mesh: FillMesh, expectedArea: number): TriangleMeshInput {
  return {
    vertices: Array.from(
      { length: mesh.positions.length / 2 },
      (_, i) => [mesh.positions[2 * i]!, mesh.positions[2 * i + 1]!] as const,
    ),
    indices: Array.from(mesh.indices),
    bounds: [mesh.bounds.minX, mesh.bounds.minY, mesh.bounds.maxX, mesh.bounds.maxY] as const,
    expectedArea,
  };
}

describe('A02: line-fill sources through the release fill-v0 port', () => {
  it('meshes all 32 source/rule cases to the independent oracle region', async () => {
    const port = await createFillMeshPort(module);
    try {
      const cases = LINE_FILL_SOURCES.flatMap((source) =>
        LINE_FILL_RULES.map((rule) => ({ source, rule })),
      );
      expect(cases).toHaveLength(32);
      const result = port.buildFillMeshes(
        cases.map(({ source, rule }, requestId) => ({
          requestId,
          verbs: Uint8Array.from(
            source.contours.flatMap((c) => [MOVE, ...c.slice(1).map(() => LINE), CLOSE]),
          ),
          points: Float64Array.from(source.contours.flat(2)),
          fillRule: rule,
          toleranceExponent: REGION_EXPONENT,
        })),
      );
      if (result.status !== 'ok') throw new Error(`batch ${result.status}`);
      cases.forEach(({ source, rule }, i) => {
        const label = `${source.id}:${rule}`;
        const r = result.results[i]!;
        const area = source.areas[rule];
        if (area === 0) {
          expect(r.status, label).toBe('empty');
          return;
        }
        expect(r.status, label).toBe('ok');
        if (r.status !== 'ok') return;
        expect(checkFillMesh(r.mesh), `${label} section f`).toEqual([]);
        expect(
          checkFillRegion(r.mesh, source.contours, rule, area),
          `${label} fill-region oracle`,
        ).toEqual([]);
        expect(
          inspectLineFillMesh({
            contours: source.contours,
            rule,
            mesh: triangleInput(r.mesh, area),
          }),
          `${label} region equality`,
        ).toEqual({ valid: true, issue: null });
      });
    } finally {
      port.dispose();
    }
  });
});
