import { defineConfig } from 'vitest/config';

// D9 E3 unit E3-U2: one shard of the oracle-only A04 freeze check. Manual, never CI; run it
// through `pnpm e3-a04:freeze`, which starts the shards and merges their results.
export default defineConfig({
  test: {
    include: ['tests/geometry/e3-a04/freeze.check.ts'],
    testTimeout: 172_800_000,
    hookTimeout: 60_000,
  },
});
