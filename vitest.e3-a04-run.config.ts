import { defineConfig } from 'vitest/config';

// D9 E3 unit E3-U3: one phase of the A04 measurement run. Manual, never CI; run it through
// `pnpm e3-a04:run`, which starts the shards, then the finalize phase.
export default defineConfig({
  test: {
    include: ['tests/geometry/e3-a04/run.check.ts'],
    testTimeout: 172_800_000,
    hookTimeout: 60_000,
  },
});
