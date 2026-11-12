import { readFile } from 'node:fs/promises';
import { PATH_VERB_CODES } from '@vector-studio/contracts';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  createFillMeshPort,
  createStrokeMeshPort,
} from '../../packages/geometry-wasm/src/index.js';
import {
  freehandPath,
  polygonPath,
  type PathData,
} from '../../packages/editor-core/src/freehand.js';

// V-40 (contract section 5): the pencil's fitted paths and the polygon tool's paths build their
// fill and a 1 px stroke on the real kernel, so neither draws nothing (the V-25 star failure).

let module: WebAssembly.Module;
beforeAll(async () => {
  if (!process.env.P2_WASM_PATH) throw new Error('Run through pnpm test:geometry');
  module = await WebAssembly.compile(new Uint8Array(await readFile(process.env.P2_WASM_PATH)));
});

type P = { x: number; y: number };

function wave(jitter: number): P[] {
  const out: P[] = [];
  for (let x = 0; x <= 300; x += 2) {
    const noise = (((x * 7919) % 13) / 13 - 0.5) * 2 * jitter;
    out.push({ x, y: 80 + 50 * Math.sin(x / 25) + noise });
  }
  return out;
}

function loop(): P[] {
  const out: P[] = [];
  for (let i = 0; i <= 150; i += 1) {
    const a = (2 * Math.PI * i) / 150;
    out.push({ x: 120 + 70 * Math.cos(a) + 8 * Math.cos(5 * a), y: 120 + 50 * Math.sin(a) });
  }
  return out;
}

/** A back-and-forth scribble: tight turns (hairpins) between long strokes. */
function scribble(): P[] {
  const out: P[] = [];
  for (let row = 0; row < 6; row += 1) {
    for (let k = 0; k <= 40; k += 1) {
      const t = row % 2 === 0 ? k / 40 : 1 - k / 40;
      out.push({ x: 20 + 200 * t, y: 20 + row * 6 + 2 * Math.sin(k) });
    }
  }
  return out;
}

const cases: [string, PathData][] = [
  ['wave', freehandPath(wave(0), 1)!],
  ['jittered wave', freehandPath(wave(1.5), 1)!],
  ['closed loop', freehandPath(loop(), 1)!],
  ['scribble', freehandPath(scribble(), 1)!],
  ['scribble at zoom 4', freehandPath(scribble(), 4)!],
  ...[3, 4, 5, 6, 7, 8, 9, 12, 24, 60].map(
    (sides) =>
      [`polygon ${sides}`, polygonPath({ x: 30, y: 40, width: 120, height: 100 }, sides)!] as [
        string,
        PathData,
      ],
  ),
  ['polygon 5 square', polygonPath({ x: 0, y: 0, width: 120, height: 120 }, 5)!],
];

describe('V-40 pencil and polygon paths on the real kernel', () => {
  it.each(cases)('%s: fill and 1 px stroke of each join build', async (_, data) => {
    const fillPort = await createFillMeshPort(module);
    const strokePort = await createStrokeMeshPort(module);
    const verbs = Uint8Array.from(data.verbs, (verb) => PATH_VERB_CODES[verb]);
    const coords = Float64Array.from(data.points);
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
        expect(stroke.status === 'ok' && stroke.results[0]!.status, `e ${e} ${join}`).toBe('ok');
      }
    }
  });
});
