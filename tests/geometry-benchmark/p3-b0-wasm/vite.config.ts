import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';

// AL-S2 page build and preview (contract section 5.2), as the P2.5 page's: the release WASM
// and the B0 framed corpus are emitted as assets and verified by SHA-256 in the page. The
// preview serves the page cross-origin isolated, which gives `performance.now` its finest
// resolution; the page records `crossOriginIsolated` and the observed quantum.
const wasm = process.env.P3_B0_WASM_PATH;
const corpus = process.env.P3_B0_WASM_CORPUS_PATH;
const output = process.env.P3_B0_WASM_BUILD_DIR;
if (!wasm || !corpus || !output) throw new Error('Build through pnpm benchmark:p3-b0-wasm.');
const isolation = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};
export default defineConfig({
  root: import.meta.dirname,
  base: './',
  build: { outDir: output, emptyOutDir: false },
  preview: { headers: isolation },
  plugins: [
    {
      name: 'p3-b0-wasm-assets',
      generateBundle() {
        this.emitFile({ type: 'asset', fileName: 'geometry.wasm', source: readFileSync(wasm) });
        this.emitFile({ type: 'asset', fileName: 'corpus.bin', source: readFileSync(corpus) });
      },
    },
  ],
});
