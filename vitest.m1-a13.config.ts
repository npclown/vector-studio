import { defineConfig } from 'vitest/config';

// M1-A13: the 10,000-node load, projection, move and isolation observation (no claim). Manual,
// never CI; run it through `pnpm observe:m1-a13`.
export default defineConfig({
  test: {
    include: ['tests/m1-a13/observation.check.ts'],
    testTimeout: 3_600_000,
  },
});
