import type { RendererFactory, RendererHandle } from '@vector-studio/react';
import { benchBackendOptions, pageBench } from './e26-bench';

// P5-U6 (P5 plan, section 6 and P5-Q8): the host's renderer, composed as the V-1 playground page
// composes it: the P1 primitive and P3 path renderer service on the WebGPU backend, with the
// fill-mesh and stroke-mesh ports from geometry-wasm. Every renderer module is loaded by dynamic
// `import()` inside the factory, which runs only in the canvas effect, so nothing here is
// evaluated during prerender. Precision stays UNVERIFIED until P3 A04 evidence exists.
// M1-U5: the service draws rect and mask clips (P4), which M1 frames and mask groups project to.
// With `?test=1` the backend also enables the E10 frame capture, and `window.__nextHostRenderer`
// gives the headed M1-A12 spec the next presented frame and the backend's diagnostics.
// M4-U4 (M4 contract, M4-P7): the service also takes `paints: 'gradient'` (E23) and
// `groups: 'isolated'` (E25) beside `clips: 'all'`, so gradient paints and translucent
// containers and instances draw instead of being isolated as `editor.renderer-unsupported`.
// E26-U1b (E26 contract, section 3.3): with `?bench=1` the backend's clock runs the bench driver
// and the service is wrapped for the injected rejection (src/e26-bench.ts); frame capture stays
// off unless `?test=1` is also given, which the harness never does.

const WASM_URL = '/geometry-kernel.wasm';

/** One presented frame: R, G, B, A bytes, rows top first, in physical pixels. */
export type NextHostFrame = Readonly<{
  width: number;
  height: number;
  devicePixelRatio: number;
  rgba: Uint8Array;
}>;

/** A backend diagnostic, as the test hook records it. */
export type NextHostDiagnostic = Readonly<{ code: string; severity: string; message: string }>;

declare global {
  interface Window {
    /** Present only with `?test=1` while a renderer exists; `capture` needs it to be ready. */
    __nextHostRenderer?: Readonly<{
      capture: () => Promise<NextHostFrame>;
      diagnostics: readonly NextHostDiagnostic[];
    }>;
  }
}

function nextAnimationFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

export const createWebGpuRenderer: RendererFactory = async (canvas, size) => {
  const [geometry, core, webgpu] = await Promise.all([
    import('@vector-studio/geometry-wasm'),
    import('@vector-studio/renderer-core'),
    import('@vector-studio/renderer-webgpu'),
  ]);
  const response = await fetch(WASM_URL, { cache: 'no-store' });
  if (!response.ok) {
    throw new Error(
      `The geometry kernel WASM is not available at ${WASM_URL} (HTTP ${response.status}). ` +
        'Build it with `pnpm test:geometry`, or set VECTOR_STUDIO_GEOMETRY_WASM.',
    );
  }
  const bytes = await response.arrayBuffer();
  // Everything created so far is released on any failure, in the playground's order: service,
  // backend, then the kernel ports (apps/playground/src/viz-v1-appearance.ts).
  const releases: (() => void)[] = [];
  const dispose = () => {
    for (const release of releases.splice(0).reverse()) release();
  };
  try {
    // Two instances of the one kernel: each port owns its own linear memory.
    const fill = await geometry.createFillMeshPort(bytes);
    releases.push(() => fill.dispose());
    const stroke = await geometry.createStrokeMeshPort(bytes);
    releases.push(() => stroke.dispose());
    const testing = new URLSearchParams(window.location.search).get('test') === '1';
    const bench = pageBench();
    const backend = new webgpu.WebGpuBackend(
      benchBackendOptions(window.location.search, bench?.clock ?? null),
    );
    releases.push(() => backend.dispose());
    if (testing) {
      const diagnostics: NextHostDiagnostic[] = [];
      const subscription = backend.subscribeDiagnostics(({ code, severity, message }) => {
        diagnostics.push({ code, severity, message });
      });
      releases.push(() => subscription.dispose());
      const hook = {
        diagnostics,
        capture: async (): Promise<NextHostFrame> => {
          // Two frames for the last change to settle, then the next presented frame.
          backend.invalidate({ reason: 'scene' });
          await nextAnimationFrame();
          await nextAnimationFrame();
          const frame = await backend.captureFrameForTesting({ timeoutMs: 30_000 });
          return {
            width: frame.width,
            height: frame.height,
            devicePixelRatio: frame.devicePixelRatio,
            rgba: frame.rgba,
          };
        },
      };
      window.__nextHostRenderer = hook;
      releases.push(() => {
        if (window.__nextHostRenderer === hook) delete window.__nextHostRenderer;
      });
    }
    const service = new core.PrimitiveRendererService(backend, {
      fillMesh: fill,
      fillMeshMemoryBytes: () => fill.linearMemoryBytes(),
      strokeMesh: stroke,
      strokeMeshMemoryBytes: () => stroke.linearMemoryBytes(),
      clips: 'all',
      paints: 'gradient',
      groups: 'isolated',
    });
    releases.push(() => service.dispose());
    const source = backend.attachPrimitiveFrameSource(service);
    releases.push(() => source.dispose());
    const capability = await backend.initialize({
      canvas,
      cssSize: { width: size.width, height: size.height },
      devicePixelRatio: size.devicePixelRatio,
    });
    if (!capability.supported) {
      throw new Error(`WebGPU is not available: ${capability.diagnostic.message}`);
    }
    let renderer: RendererHandle['renderer'] = service;
    if (bench !== null) {
      bench.attach(backend, canvas);
      releases.push(() => bench.detach());
      renderer = bench.wrapRenderer(service);
    }
    const handle: RendererHandle = { renderer, dispose };
    return handle;
  } catch (error) {
    dispose();
    throw error;
  }
};
