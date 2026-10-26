import { defineConfig } from 'vitest/config';

// E17 acceptance check E17-A4: the snap-model run over the gated V-4 case-variants. Manual,
// never CI; run it through `pnpm e17:snap-model`.
export default defineConfig({
  test: {
    include: ['tests/geometry/e17/snap-model.check.ts'],
    testTimeout: 3_600_000,
  },
});
