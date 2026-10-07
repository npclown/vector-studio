import { defineConfig } from 'vitest/config';

// P3.1p T01 report and replay (docs/plans/p3-t01-extent-experiment-contract.md); excluded from
// pnpm test:geometry. Writing is gated by P3_T01_WRITE=1, replay by P3_T01_REPLAY=1.
export default defineConfig({
  test: {
    include: ['tests/p3-t01/**/*.test.ts'],
    fileParallelism: false,
    maxWorkers: 1,
    testTimeout: 10_800_000,
  },
});
