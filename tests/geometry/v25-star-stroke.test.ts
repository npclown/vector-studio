import { readFile } from 'node:fs/promises';
import { PATH_VERB_CODES } from '@vector-studio/contracts';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  createFillMeshPort,
  createStrokeMeshPort,
} from '../../packages/geometry-wasm/src/index.js';
import { starExtension } from '../../packages/editor-core/src/star.js';

// V-25 (user report 2026-11-06): the default "Create star" star (5 points, inner ratio 0.5,
// 120 x 120) drew nothing. Before its vertices were snapped to a 2^-16 px grid
// (packages/editor-core/src/star.ts) the stroke-v0 kernel answered unsupported-geometry for its
// stroke at every exponent and every join, and a failed stroke hides the path's fill too.

let module: WebAssembly.Module;
beforeAll(async () => {
  if (!process.env.P2_WASM_PATH) throw new Error('Run through pnpm test:geometry');
  module = await WebAssembly.compile(new Uint8Array(await readFile(process.env.P2_WASM_PATH)));
});

const toScene = (starExtension.nodeTypes ?? [])[0]!.toScene;

describe('V-25 star stroke and fill on the real kernel', () => {
  it('builds the fill and a 1 px stroke of each join for the stars that failed', async () => {
    const fillPort = await createFillMeshPort(module);
    const strokePort = await createStrokeMeshPort(module);
    for (const [points, innerRatio] of [
      [5, 0.5],
      [5, 0.4],
      [7, 0.3],
    ] as const) {
      const scene = toScene({ points, innerRatio }, { x: 120, y: 120, width: 120, height: 120 });
      const verbs = Uint8Array.from(scene.verbs, (verb) => PATH_VERB_CODES[verb]);
      const coords = Float64Array.from(scene.points);
      for (const e of [-4, -3, -2]) {
        const fill = fillPort.buildFillMeshes([
          { requestId: 0, verbs, points: coords, fillRule: 'nonzero', toleranceExponent: e },
        ]);
        expect(fill.status === 'ok' && fill.results[0]!.status).toBe('ok');
        for (const join of ['miter', 'bevel', 'round'] as const) {
          const stroke = strokePort.buildStrokeMeshes([
            {
              requestId: 0,
              verbs,
              points: coords,
              width: 1,
              cap: 'butt',
              join,
              miterLimit: 4,
              toleranceExponent: e,
            },
          ]);
          expect(stroke.status === 'ok' && stroke.results[0]!.status).toBe('ok');
        }
      }
    }
  });
});
