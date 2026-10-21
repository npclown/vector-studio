import { readFile } from 'node:fs/promises';
import { beforeAll, expect } from 'vitest';
import {
  createFillMeshPort,
  createStrokeMeshPort,
} from '../../packages/geometry-wasm/src/index.js';
import { describeStrokeMeshPortConformance } from '../support/stroke-mesh-port-conformance.js';

// P3 B2 ST-A8: the shared stroke conformance suite SC01-SC22 against the release WASM adapter.
// Results are functional evidence; precision is UNVERIFIED until B4 has A04 evidence.

let module: WebAssembly.Module;
beforeAll(async () => {
  if (!process.env.P2_WASM_PATH) throw new Error('Run through pnpm test:geometry');
  module = await WebAssembly.compile(new Uint8Array(await readFile(process.env.P2_WASM_PATH)));
});

describeStrokeMeshPortConformance(
  'geometry-wasm stroke-v0',
  async () => {
    const adapter = await createStrokeMeshPort(module);
    return {
      port: adapter,
      dispose: () => adapter.dispose(),
      forceMemoryGrowth: () => {
        const before = adapter.linearMemoryBytes();
        // Forty 65,538-verb paths pack about 44 MiB of input, which the input arena must
        // hold, so linear memory grows. Each path is a source-cap work-limit.
        const verbs = new Uint8Array(65_538).fill(1);
        verbs[0] = 0;
        const points = new Float64Array(2 * 65_538);
        const result = adapter.buildStrokeMeshes(
          Array.from({ length: 40 }, (_, requestId) => ({
            requestId,
            verbs,
            points,
            width: 2,
            cap: 'butt' as const,
            join: 'miter' as const,
            miterLimit: 4,
            toleranceExponent: 0,
          })),
        );
        expect(result.status).toBe('ok');
        expect(adapter.linearMemoryBytes()).toBeGreaterThan(before);
      },
    };
  },
  {
    operationId: 'geometry-wasm/stroke-v0+r3',
    createFillPort: async () => {
      const adapter = await createFillMeshPort(module);
      return { port: adapter, dispose: () => adapter.dispose() };
    },
  },
);
