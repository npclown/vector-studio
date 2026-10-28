import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { PATH_VERB_CODES } from '@vector-studio/contracts';
import type { LineNode } from '../../packages/model/src/index.js';
import { lineContent } from '../../packages/editor-core/src/projector.js';
import { createFillMeshPort } from '../../packages/geometry-wasm/src/index.js';
// Source import: the path-mesh limits are package-internal.
import { PATH_MESH_LIMITS } from '../../packages/renderer-core/src/path-mesh-pipeline.js';

// MVP M1-U5 regression (M1 contract, section 5 line fill mode): the containers fixture's arrow
// line l1 (round caps, a line head at P0 and a triangle at P1) projects to a fill outline that
// the real fill kernel meshes. With cubic half-disc caps it failed (`work-limit` as projected,
// `unsupported-geometry` for the shaft and cap alone); the 16-segment caps are line-only.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

let module: WebAssembly.Module;
let l1: LineNode;
beforeAll(async () => {
  if (!process.env.P2_WASM_PATH) throw new Error('Run through pnpm test:geometry');
  module = await WebAssembly.compile(new Uint8Array(await readFile(process.env.P2_WASM_PATH)));
  const fixture = JSON.parse(
    await readFile(path.join(root, 'tests/fixtures/m1-model/containers.json'), 'utf8'),
  ) as { nodes: Record<string, LineNode> };
  l1 = fixture.nodes.l1!;
});

/** Distinct boundary vertices, the renderer's fringe work measure. */
function boundaryVertices(edges: Uint32Array): number {
  return new Set(edges).size;
}

describe('M1-U5 fill-mode round caps mesh in the fill kernel', () => {
  // Tolerance exponents the renderer picks at zoom 1, 2 and 8 (DPR 1).
  it.each([2, 5])('fixture l1 at stroke width %d meshes at zoom 1, 2 and 8', async (width) => {
    const line = { ...l1, stroke: { ...l1.stroke!, width } } as LineNode;
    const { geometry, style } = lineContent(line);
    // Fill mode: shaft, the P0 cap, the two line-head rectangles and the triangle.
    expect(style.stroke).toBeNull();
    expect(geometry.verbs.filter((verb) => verb === 'move')).toHaveLength(5);
    expect(geometry.verbs).not.toContain('cubic');
    const port = await createFillMeshPort(module);
    try {
      const result = port.buildFillMeshes(
        [-3, -4, -6].map((toleranceExponent, requestId) => ({
          requestId,
          verbs: Uint8Array.from(geometry.verbs, (verb) => PATH_VERB_CODES[verb]),
          points: Float64Array.from(geometry.points),
          fillRule: geometry.fillRule,
          toleranceExponent,
        })),
      );
      if (result.status !== 'ok') throw new Error(`batch failed: ${result.code}`);
      for (const entry of result.results) {
        expect(entry.status, JSON.stringify(entry)).toBe('ok');
        if (entry.status !== 'ok') continue;
        // Drawn with its coverage fringe: under the renderer's fringe work cap.
        expect(boundaryVertices(entry.mesh.boundaryEdges)).toBeLessThanOrEqual(
          PATH_MESH_LIMITS.fringeBoundaryVertexCap,
        );
      }
    } finally {
      port.dispose();
    }
  });
});
