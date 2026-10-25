import { defineConfig } from 'vitest/config';

// D9 E14-U1 E14-A3 oracle check. Run through `pnpm e14:rung0-oracle`, never in CI.
export default defineConfig({
  test: {
    include: ['tests/geometry/e14/rung0-oracle.check.ts'],
    // The largest shard runs about 4.7 hours on a 4-core container; no per-test timeout.
    testTimeout: 0,
  },
});
