import { defineConfig } from 'vitest/config';

// A03 stroke rejection diagnostic input. Run through `pnpm a03:stroke-diag`
// (tooling/run-a03-stroke-diag.mjs), never in CI.
export default defineConfig({
  test: {
    include: ['tests/geometry/a03/stroke-input.check.ts'],
    testTimeout: 600_000,
  },
});
