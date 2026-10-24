import { readFile } from 'node:fs/promises';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  createFillMeshPort,
  createStrokeMeshPort,
} from '../../packages/geometry-wasm/src/index.js';
import { drawCase, measureCase, type HarnessPorts } from './e3-a04/harness.js';
import { SMOKE_CASES } from './e3-a04/smoke.js';

// D9 E3 unit E3-U3: the harness on the real release WASM through createFillMeshPort and
// createStrokeMeshPort (contract section 7.1), on the smoke cases of section 15.6 only. They are
// not corpus cases, so no kernel output on the corpus is read before the freeze (section 5.5).
// Run through `pnpm test:geometry`, which builds the WASM and sets P2_WASM_PATH.

let ports: HarnessPorts;
beforeAll(async () => {
  if (!process.env.P2_WASM_PATH) throw new Error('Run through pnpm test:geometry');
  const module = await WebAssembly.compile(
    new Uint8Array(await readFile(process.env.P2_WASM_PATH)),
  );
  ports = { fill: await createFillMeshPort(module), stroke: await createStrokeMeshPort(module) };
});

describe('E3-U3 harness on the release WASM (smoke cases, not the corpus)', () => {
  for (const smoke of SMOKE_CASES) {
    if (smoke.slow === true) {
      // The oracle takes minutes on a stroke region; `pnpm e3-a04:run --smoke` measures it.
      it(`${smoke.id}: draws a mesh through the product path`, () => {
        const outcome = drawCase(smoke.kase, ports);
        expect(outcome.kind).toBe('drawn');
      });
      continue;
    }
    it(`${smoke.id}: ${smoke.expect}`, () => {
      const row = measureCase(smoke.kase, ports);
      expect(row.id).toBe(smoke.id);
      if (smoke.expect === 'pass') {
        expect(row.status).toBe('pass');
        expect(row.drawn).toBe('mesh');
        expect(row.u!).toBeLessThanOrEqual(0.25);
        expect(row.betaC!).toBeGreaterThan(0);
      } else {
        // The other smoke cases only show that the whole path runs to a status.
        expect(['pass', 'fail', 'undecided', 'window-empty', 'rejected']).toContain(row.status);
      }
    });
  }
});
