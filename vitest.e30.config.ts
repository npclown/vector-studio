import { defineConfig } from 'vitest/config';

// E30 (renderer cost): the container profile of prepare at the fitted camera F of the M1-A13
// page. Manual, never CI; run it through `pnpm check:e30`.
export default defineConfig({
  test: {
    include: ['tests/e26/e30-profile.check.ts'],
    testTimeout: 1_800_000,
  },
});
