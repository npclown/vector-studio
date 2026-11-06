import { readFile } from 'node:fs/promises';
import { PATH_VERB_CODES, type ScenePathVerb } from '@vector-studio/contracts';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  createFillMeshPort,
  createStrokeMeshPort,
} from '../../packages/geometry-wasm/src/index.js';
import { coarseFallbacksForTesting } from '../../packages/renderer-core/src/path-mesh-pipeline.js';
import { createStrokeHarness, pathStroke, strokedNode } from '../support/st-u6-stroke-harness.js';

// V-25 (user report 2026-11-06): a closed pen path drew nothing. Its last cubic runs from the
// last anchor (a corner) out to the first anchor's in handle about 40 px away and back to the
// first anchor, a tight hairpin. The stroke-v0 kernel answers work-limit for it at exponents -2
// and finer at stroke-v0+r7 (the renderer asked for -3 at zoom 1), so the whole path was hidden.
// The renderer retries at coarser exponents (path-mesh-pipeline `#coarser`), and since
// stroke-v0+r8 (D9 E35) the kernel builds both paths at -3 itself, so no coarser retry is used.

/** The user's node-5: unit-box points scaled by its frame (494.4 x 508.8). */
const UNIT = [
  0.8980582143725061, 0.0283019020702528, 0.7961164287450123, 0.0566038041405056,
  0.6715210227140507, 0.05031447257616798, 0.5501618128970209, 0.1902515900568366,
  0.4288026030799912, 0.3301887075375052, 0, 0.1430818432423484, 0.31715210535772936,
  0.46383649345383615, 0.6343042107154587, 0.7845911436653239, 0.5453073951231509, 1,
  0.7281553206286645, 0.765723268931333, 0.9110032461341782, 0.5314465378626662, 0.9902911644522598,
  0.275157236288084, 0.9822005504644579, 0.18710692427466777, 0.9741099364766559,
  0.09905661226125155, 0.923948154442878, 0.026729599168923895, 0.923948154442878,
  0.026729599168923895, 0.923948154442878, 0.026729599168923895, 1, 0, 0.8980582143725061,
  0.0283019020702528,
];
const POINTS = UNIT.map((value, index) => value * (index % 2 === 0 ? 494.4 : 508.8));
const VERBS: ScenePathVerb[] = ['move', ...Array<ScenePathVerb>(6).fill('cubic'), 'close'];

let module: WebAssembly.Module;
beforeAll(async () => {
  if (!process.env.P2_WASM_PATH) throw new Error('Run through pnpm test:geometry');
  module = await WebAssembly.compile(new Uint8Array(await readFile(process.env.P2_WASM_PATH)));
});

describe('V-25 hairpin pen path (work-limit fallback)', () => {
  it('the stroke kernel builds the path at -3, -2 and -1 (E35)', async () => {
    const port = await createStrokeMeshPort(module);
    const status = (toleranceExponent: number) => {
      const batch = port.buildStrokeMeshes([
        {
          requestId: 0,
          verbs: Uint8Array.from(VERBS, (verb) => PATH_VERB_CODES[verb]),
          points: Float64Array.from(POINTS),
          width: 1,
          cap: 'butt',
          join: 'miter',
          miterLimit: 4,
          toleranceExponent,
        },
      ]);
      if (batch.status !== 'ok') return batch.code;
      const result = batch.results[0]!;
      return result.status === 'failed' ? result.code : result.status;
    };
    expect([status(-3), status(-2), status(-1)]).toEqual(['ok', 'ok', 'ok']);
  });

  it('draws the stroke through the pipeline with the real ports', async () => {
    const h = createStrokeHarness({
      fillPort: await createFillMeshPort(module),
      strokePort: await createStrokeMeshPort(module),
      nodes: [
        strokedNode('node-5', 0, {
          verbs: VERBS,
          points: POINTS,
          fill: null,
          stroke: pathStroke({ color: { r: 1, g: 1, b: 1, a: 1 }, width: 1 }),
        }),
      ],
    });
    const frame = h.prepare();
    expect(frame.draws.map((draw) => `${draw.nodeId}:${draw.paint}`)).toEqual(['node-5:stroke']);
    expect(frame.notices).toEqual([]);
    expect(coarseFallbacksForTesting(h.pipeline)).toBe(0);
  });

  it('draws a triangle with a cubic anchor of 1 px handles (the #520 case) the same way', async () => {
    const h = createStrokeHarness({
      fillPort: await createFillMeshPort(module),
      strokePort: await createStrokeMeshPort(module),
      nodes: [
        strokedNode('tiny', 0, {
          verbs: ['move', 'cubic', 'cubic', 'line', 'close'],
          points: [0, 0, 0, 0, 99, 0.4, 100, 0, 101, -0.4, 50, 80, 50, 80, 0, 60],
          stroke: pathStroke({ width: 1 }),
        }),
      ],
    });
    const frame = h.prepare();
    expect(frame.draws.map((draw) => `${draw.nodeId}:${draw.paint}`)).toEqual([
      'tiny:fill',
      'tiny:stroke',
    ]);
    expect(frame.notices).toEqual([]);
    expect(coarseFallbacksForTesting(h.pipeline)).toBe(0);
  });
});
