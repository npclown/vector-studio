import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { include: ['tests/geometry-benchmark/records.test.ts'], fileParallelism: false },
});
