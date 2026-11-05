import type { RendererFactory, RendererHandle } from '@vector-studio/react';
import { benchBackendOptions, pageBench } from './e26-bench';
import { createGlyphRasterLog, hostRendererOptions, type GlyphRasterLog } from './renderer-options';

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
// M6c-U2 (M6c contract, section 5): the service also takes `text: 'atlas'` with the canvas glyph
// raster port (src/renderer-options.ts), so projected text draws. With `?test=1` the service is
// wrapped by the cluster probe's scene recorder (src/m6c-text-probe.ts, loaded only then), the
// probe is registered with the host's size, port and options, and `window.__nextHostRenderer`
// gains the service's `glyphRasterCalls` and `glyphUploads` counters. M6c-U4: with `?test=1` the
// host's service calls the glyph raster port through a log (`glyphRasterLog`), each call with the
// newest text generation the recorder holds; the probe keeps the unlogged port.
// AR-U1 (alpha release plan, ADR 0004): the composition itself is `@vector-studio/webgpu-host`'s
// `createWebGpuRendererFactory`; this module only adds next-host's `?test=1` and `?bench=1`
// hooks through its stages, in the order they ran here before.

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
      /** M6c-U2: the service's glyph raster port calls (E28 `getGlyphRasterCallsForTesting`). */
      readonly glyphRasterCalls: number;
      /** M6c-U2: bitmaps uploaded by acknowledged packets (`getGlyphUploadsForTesting`). */
      readonly glyphUploads: number;
      /** M6c-U4: the host service's glyph raster port calls (src/renderer-options.ts). */
      readonly glyphRasterLog: GlyphRasterLog;
    }>;
  }
}

function nextAnimationFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

export const createWebGpuRenderer: RendererFactory = async (canvas, size) => {
  const host = await import('@vector-studio/webgpu-host');
  const testing = new URLSearchParams(window.location.search).get('test') === '1';
  const bench = pageBench();
  // M6c-U4: under `?test=1` the host's service calls the port through a log (the probe does not).
  let rasterLog: GlyphRasterLog | null = null;
  const factory = host.createWebGpuRendererFactory({
    wasm: async () => {
      const response = await fetch(WASM_URL, { cache: 'no-store' });
      if (!response.ok) {
        throw new host.GeometryWasmUnavailableError(
          `The geometry kernel WASM is not available at ${WASM_URL} (HTTP ${response.status}). ` +
            'Build it with `pnpm test:geometry`, or set VECTOR_STUDIO_GEOMETRY_WASM.',
        );
      }
      return response.arrayBuffer();
    },
    backendOptions: () => benchBackendOptions(window.location.search, bench?.clock ?? null),
    wrapGlyphRaster: (port) => {
      if (!testing) return port;
      rasterLog = createGlyphRasterLog(port);
      return rasterLog.port;
    },
    beforeInitialize: testing
      ? async ({ backend, service, glyphRaster, addRelease }) => {
          // Each release is registered as it is created, so a throw here still cleans up.
          const releases = { push: addRelease };
          const diagnostics: NextHostDiagnostic[] = [];
          const subscription = backend.subscribeDiagnostics(({ code, severity, message }) => {
            diagnostics.push({ code, severity, message });
          });
          releases.push(() => subscription.dispose());
          const log = rasterLog!;
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
            get glyphRasterCalls() {
              return service.getGlyphRasterCallsForTesting();
            },
            get glyphUploads() {
              return service.getGlyphUploadsForTesting();
            },
            /** M6c-U4: the host service's raster port calls, with the generation of each. */
            glyphRasterLog: log,
          };
          window.__nextHostRenderer = hook;
          releases.push(() => {
            if (window.__nextHostRenderer === hook) delete window.__nextHostRenderer;
          });
          const [probe, core, webgpu] = await Promise.all([
            import('./m6c-text-probe'),
            import('@vector-studio/renderer-core'),
            import('@vector-studio/renderer-webgpu'),
          ]);
          const recorder = new probe.SceneRecorder();
          const renderer = recorder.wrap(service);
          log.setGeneration(() => recorder.newestTextGeneration());
          releases.push(
            probe.attachTextProbe({
              recorder,
              size,
              glyphRaster,
              createBackend: () => new webgpu.WebGpuBackend({ frameCaptureForTesting: true }),
              createService: (target) =>
                new core.PrimitiveRendererService(target, hostRendererOptions(glyphRaster)),
            }),
          );
          return { renderer };
        }
      : undefined,
    afterInitialize:
      bench !== null
        ? ({ backend, renderer, addRelease }) => {
            bench.attach(backend, canvas);
            addRelease(() => bench.detach());
            return { renderer: bench.wrapRenderer(renderer) };
          }
        : undefined,
  });
  const handle: RendererHandle = await factory(canvas, size);
  return handle;
};
