import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/geometry/coverage-oracle/coverage-metrics.test.ts'],
    fileParallelism: false,
    maxWorkers: 1,
    testTimeout: 1_200_000,
  },
});
