import { readFileSync } from 'node:fs';
import path from 'node:path';
import { defineConfig } from 'vite';

// AL-OB5 page build and preview (proposal section 3.1), as AL-S2's: the release WASM and the
// TypeScript-encoded framed corpus are emitted as assets and verified by SHA-256 in the page.
// The preview serves the page cross-origin isolated, which gives `performance.now` its finest
// resolution; the page records `crossOriginIsolated` and the observed quantum. The contracts
// package is resolved to its sources, because the renderer observation (OB5-SR) imports its
// runtime constants and the page must not depend on a prior package build.
const wasm = process.env.P3_AL_OB5_WASM_PATH;
const corpus = process.env.P3_AL_OB5_CORPUS_PATH;
const output = process.env.P3_AL_OB5_BUILD_DIR;
if (!wasm || !corpus || !output) throw new Error('Build through pnpm benchmark:p3-al-ob5.');
const isolation = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};
export default defineConfig({
  root: import.meta.dirname,
  base: './',
  resolve: {
    alias: {
      '@vector-studio/contracts': path.resolve(
        import.meta.dirname,
        '../../../packages/contracts/src/index.ts',
      ),
    },
  },
  build: { outDir: output, emptyOutDir: false },
  preview: { headers: isolation },
  plugins: [
    {
      name: 'p3-al-ob5-assets',
      generateBundle() {
        this.emitFile({ type: 'asset', fileName: 'geometry.wasm', source: readFileSync(wasm) });
        this.emitFile({ type: 'asset', fileName: 'corpus.bin', source: readFileSync(corpus) });
      },
    },
  ],
});
