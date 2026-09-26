import { readFile } from 'node:fs/promises';
import { defineConfig, type Plugin } from 'vite';

const wasmPath = process.env.P2_WASM_PATH;
if (!wasmPath) throw new Error('P2_WASM_PATH is required');

function geometryWasmFixture(path: string): Plugin {
  return {
    name: 'p2-geometry-wasm-fixture',
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        if (request.url !== '/__p2/geometry.wasm') {
          next();
          return;
        }
        void readFile(path).then(
          (bytes) => {
            response.statusCode = 200;
            response.setHeader('Content-Type', 'application/wasm');
            response.setHeader('Cache-Control', 'no-store');
            response.end(bytes);
          },
          (error: Error) => next(error),
        );
      });
    },
  };
}

export default defineConfig({
  root: import.meta.dirname,
  plugins: [geometryWasmFixture(wasmPath)],
});
