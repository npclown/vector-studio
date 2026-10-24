import { defineConfig } from 'vitest/config';

// D9 E3: the A04 corpus, oracle and harness unit tests (E3-U1 to E3-U3), without the WASM build.
export default defineConfig({
  test: {
    include: ['tests/geometry/e3-a04*.test.ts'],
    // The harness on the release WASM runs in pnpm test:geometry, which builds it.
    exclude: ['tests/geometry/e3-a04-harness-wasm.test.ts'],
    testTimeout: 300_000,
    hookTimeout: 300_000,
  },
});
