import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: [
      'tests/geometry/coverage-oracle/coverage-o02-metrics.test.ts',
      'tests/geometry/coverage-oracle/coverage-o02-document.test.ts',
    ],
    fileParallelism: false,
    maxWorkers: 1,
    testTimeout: 3_600_000,
  },
});
