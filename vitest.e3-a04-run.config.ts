import { defineConfig } from 'vitest/config';

// D9 E3 unit E3-U3: the A04 measurement run (controls, shards, finalize). Manual, never CI; start
// it through `pnpm e3-a04:run`, which checks the corpus freeze gate first.
export default defineConfig({
  test: {
    include: ['tests/geometry/e3-a04/run.check.ts'],
    testTimeout: 172_800_000,
    hookTimeout: 60_000,
  },
});
