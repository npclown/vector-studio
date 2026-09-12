import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    rollupOptions: {
      input: {
        main: `${import.meta.dirname}/index.html`,
        primitives: `${import.meta.dirname}/p1-fixture.html`,
      },
    },
  },
});
