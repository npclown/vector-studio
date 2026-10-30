import { defineConfig } from 'vitest/config';

// M4-A13: the 10,000 stroked rectangle load, projection and `setStyle` observation (no claim).
// Manual, never CI; run it through `pnpm observe:m4-a13`. The frame time is the headed spec's
// `M4-A13` test (playwright.m4-next-host.config.ts).
export default defineConfig({
  test: {
    include: ['tests/m4-a13/observation.check.ts'],
    testTimeout: 3_600_000,
  },
});
