import { defineConfig } from 'vitest/config';

// V-4 unit VZ4-U1: the Node pre-run of the A08 expected statuses. Manual, never CI; run it
// through `pnpm viz-v4:expected`, which refuses before the E3 corpus freeze record.
export default defineConfig({
  test: {
    include: ['tests/visual/viz-v4/expected.check.ts'],
    testTimeout: 3_600_000,
  },
});
