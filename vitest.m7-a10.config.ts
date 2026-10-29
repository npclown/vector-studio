import { defineConfig } from 'vitest/config';

// M7-A10: the 100-instance load, projection, source edit, instance move and detach observation
// (no claim). Manual, never CI; run it through `pnpm observe:m7-a10`.
export default defineConfig({
  test: {
    include: ['tests/m7-a10/observation.check.ts'],
    testTimeout: 3_600_000,
  },
});
