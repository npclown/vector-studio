import { defineConfig } from 'vitest/config';

// P3.1p T02 report and replay (docs/plans/p3-r2-tiling-contract.md); excluded from
// pnpm test:geometry. Writing is gated by P3_T02_WRITE=1, replay by P3_T02_REPLAY=<report path>.
export default defineConfig({
  test: {
    include: ['tests/p3-t02/**/*.test.ts'],
    fileParallelism: false,
    maxWorkers: 1,
    testTimeout: 10_800_000,
  },
});
