import { defineConfig } from 'vitest/config';

// D9 E14 cause diagnostic input. Run through `pnpm e14:fill-diag`
// (tooling/run-e14-fill-diag.mjs), never in CI.
export default defineConfig({
  test: {
    include: ['tests/geometry/e14/fill-input.check.ts'],
  },
});
