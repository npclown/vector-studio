import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';

const wasm = process.env.P2_WASM_PATH;
const output = process.env.P2_BUILD_DIR;
if (!wasm || !output) throw new Error('Build through pnpm benchmark:p2.');
const wasmBytes = readFileSync(wasm);
export default defineConfig({
  root: import.meta.dirname,
  build: { outDir: output, emptyOutDir: false },
  plugins: [
    {
      name: 'p2-release-wasm',
      generateBundle() {
        this.emitFile({ type: 'asset', fileName: 'geometry.wasm', source: wasmBytes });
      },
    },
  ],
});
