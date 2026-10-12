import { readFile } from 'node:fs/promises';
import { beforeAll, expect } from 'vitest';
import { createFillMeshPort } from '../../packages/geometry-wasm/src/index.js';
import { describeFillMeshPortConformance } from '../support/fill-mesh-port-conformance.js';

// P3 V2 P-C1: the shared conformance suite against the release WASM adapter.
// Results are functional evidence; precision is UNVERIFIED until B4 has A04 evidence.

let module: WebAssembly.Module;
beforeAll(async () => {
  if (!process.env.P2_WASM_PATH) throw new Error('Run through pnpm test:geometry');
  module = await WebAssembly.compile(new Uint8Array(await readFile(process.env.P2_WASM_PATH)));
});

describeFillMeshPortConformance('geometry-wasm fill-v0', async () => {
  const adapter = await createFillMeshPort(module);
  return {
    port: adapter,
    dispose: () => adapter.dispose(),
    forceMemoryGrowth: () => {
      const before = adapter.linearMemoryBytes();
      // Forty 65,537-verb paths pack about 44 MiB of input, which the input
      // arena must hold, so linear memory grows.
      const verbs = new Uint8Array(65_537).fill(1);
      verbs[0] = 0;
      const points = new Float64Array(2 * 65_537);
      const result = adapter.buildFillMeshes(
        Array.from({ length: 40 }, (_, requestId) => ({
          requestId,
          verbs,
          points,
          fillRule: 'nonzero' as const,
          toleranceExponent: 0,
        })),
      );
      expect(result.status).toBe('ok');
      expect(adapter.linearMemoryBytes()).toBeGreaterThan(before);
    },
  };
});
