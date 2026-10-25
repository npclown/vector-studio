import { defineConfig } from 'vitest/config';

// D9 E16 cause diagnostic input. Run through `pnpm e16:fill-diag`
// (tooling/run-e16-fill-diag.mjs), never in CI.
export default defineConfig({
  test: {
    include: ['tests/geometry/e16/fill-input.check.ts'],
    testTimeout: 600_000,
  },
});
