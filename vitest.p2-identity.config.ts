import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/p2-identity/**/*.test.ts'],
    testTimeout: 600_000,
    fileParallelism: false,
  },
});
