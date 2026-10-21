import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { defineConfig } from 'vite';

// P3 V4: the path page loads the geometry kernel WASM from the local build, never from a
// committed binary. VECTOR_STUDIO_GEOMETRY_WASM overrides the default `pnpm test:geometry`
// output path. The route exists only on the dev server; a static build has no kernel.
const GEOMETRY_WASM_ROUTE = '/__vector-studio/geometry-kernel.wasm';
const geometryWasmPath =
  process.env.VECTOR_STUDIO_GEOMETRY_WASM ??
  path.resolve(
    import.meta.dirname,
    '../../.tools/geometry-build/wasm32-unknown-unknown/release/vector_studio_geometry_kernel.wasm',
  );

function geometryKernelWasm() {
  return {
    name: 'vector-studio-geometry-kernel-wasm',
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        if (request.url?.split('?')[0] !== GEOMETRY_WASM_ROUTE) {
          next();
          return;
        }
        readFile(geometryWasmPath).then(
          (bytes) => {
            response.statusCode = 200;
            response.setHeader('Content-Type', 'application/wasm');
            response.setHeader('Cache-Control', 'no-store');
            response.end(bytes);
          },
          () => {
            response.statusCode = 404;
            response.end(`Geometry kernel WASM not found at ${geometryWasmPath}`);
          },
        );
      });
    },
  };
}

export default defineConfig({
  plugins: [geometryKernelWasm()],
  build: {
    rollupOptions: {
      input: {
        main: `${import.meta.dirname}/index.html`,
        primitives: `${import.meta.dirname}/p1-fixture.html`,
        runner: `${import.meta.dirname}/p1-runner.html`,
        p3NativeProjection: `${import.meta.dirname}/p3-native-projection.html`,
        p3Coverage: `${import.meta.dirname}/p3-coverage.html`,
        p3O02: `${import.meta.dirname}/p3-o02.html`,
        p3V3Mesh: `${import.meta.dirname}/p3-v3-mesh.html`,
        p3V4Paths: `${import.meta.dirname}/p3-v4-paths.html`,
        p3B2Strokes: `${import.meta.dirname}/p3-b2-strokes.html`,
      },
    },
  },
});
