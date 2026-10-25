import { defineConfig } from 'vitest/config';

// D9 E14-U1 E14-A3 oracle check. Run through `pnpm e14:rung0-oracle`, never in CI.
export default defineConfig({
  test: {
    include: ['tests/geometry/e14/rung0-oracle.check.ts'],
    testTimeout: 3_600_000,
  },
});
