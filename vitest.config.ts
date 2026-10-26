import { defineConfig } from 'vitest/config';

export default defineConfig({
  // P5-U6: the next-host page is TSX whose tsconfig preserves JSX for Next.js; tests compile it.
  oxc: { jsx: { runtime: 'automatic' } },
  test: {
    coverage: {
      enabled: false,
    },
    include: ['tests/unit/**/*.test.ts'],
  },
});
