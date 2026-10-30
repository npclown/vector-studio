import { defineConfig } from 'vitest/config';

// E26-U5c: the container profile of prepare and the twin-source differential on the M1-A13 and
// stress pages. Manual, never CI; run it through `pnpm check:e26-u5c`.
export default defineConfig({
  test: {
    include: ['tests/e26/u5c-profile.check.ts'],
    testTimeout: 1_800_000,
  },
});
