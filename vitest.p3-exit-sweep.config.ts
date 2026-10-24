import { defineConfig } from 'vitest/config';

// D9 E11 unit E11-U2: the A01 structure sweep, one phase per process. Run through
// `pnpm p3-exit:sweep` (tooling/run-p3-exit-sweep.mjs), never in CI.
export default defineConfig({
  test: {
    include: ['tests/geometry/p3-exit-sweep/run.check.ts'],
    testTimeout: 24 * 3600 * 1000,
    hookTimeout: 300_000,
  },
});
