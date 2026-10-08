import { defineConfig } from 'vitest/config';

// P3.1p T03 report and replay (docs/plans/p3-r2-tiling-rev4-contract.md); excluded from
// pnpm test:geometry. Writing is gated by P3_T03_WRITE=1, replay by P3_T03_REPLAY=<report path>.
export default defineConfig({
  test: {
    include: ['tests/p3-t03/**/*.test.ts'],
    fileParallelism: false,
    maxWorkers: 1,
    testTimeout: 10_800_000,
  },
});
