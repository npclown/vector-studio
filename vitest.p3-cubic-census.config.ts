import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/p3-census/**/*.test.ts'],
    fileParallelism: false,
    maxWorkers: 1,
    testTimeout: 900_000,
  },
});
