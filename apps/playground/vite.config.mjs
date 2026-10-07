import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    rollupOptions: {
      input: {
        main: `${import.meta.dirname}/index.html`,
        primitives: `${import.meta.dirname}/p1-fixture.html`,
        runner: `${import.meta.dirname}/p1-runner.html`,
        p3NativeProjection: `${import.meta.dirname}/p3-native-projection.html`,
        p3Coverage: `${import.meta.dirname}/p3-coverage.html`,
        p3O02: `${import.meta.dirname}/p3-o02.html`,
      },
    },
  },
});
