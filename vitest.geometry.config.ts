import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/geometry/**/*.test.ts'],
    testTimeout: 120_000,
    fileParallelism: false,
  },
});
