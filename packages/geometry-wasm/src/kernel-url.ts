// AR-U2 (alpha release plan): the URL of the geometry kernel WASM shipped in this package's
// `dist/kernel.wasm` (built by `tooling/build-geometry-kernel.mjs`). Bundlers that follow
// `new URL(..., import.meta.url)` (Vite, webpack 5 and Next.js) emit the file as an asset and
// rewrite the URL. Pass it to `createWebGpuRendererFactory({ wasm: geometryKernelUrl })` from
// `@vector-studio/webgpu-host`. This module is a separate entry (`@vector-studio/geometry-wasm/kernel`),
// so importing the package's main entry never asks a bundler for the file.

/** The geometry kernel WASM shipped with this package. */
export const geometryKernelUrl: URL = new URL('./kernel.wasm', import.meta.url);
