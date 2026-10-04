import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/p3-polygon-census/**/*.test.ts'],
    fileParallelism: false,
    maxWorkers: 2,
    testTimeout: 900_000,
  },
});
