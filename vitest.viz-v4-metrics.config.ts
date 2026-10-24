import { defineConfig } from 'vitest/config';

// V-4 unit VZ4-U2: the A08 offline metrics run and replay. Manual, never CI; run it through
// `pnpm coverage:viz-v4`, which refuses before the E3 corpus freeze record.
export default defineConfig({
  test: {
    include: ['tests/visual/viz-v4/metrics.check.ts'],
    testTimeout: 14_400_000,
  },
});
