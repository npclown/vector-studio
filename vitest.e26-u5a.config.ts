import { defineConfig } from 'vitest/config';

// E26-U5a: the M1-A13 page at the fitted view at DPR 1 (baseline B3). Manual, never CI; run it
// through `pnpm check:e26-u5a` with a large heap.
export default defineConfig({
  test: {
    include: ['tests/e26/u5a-fitted-dpr1.check.ts'],
    testTimeout: 1_800_000,
  },
});
