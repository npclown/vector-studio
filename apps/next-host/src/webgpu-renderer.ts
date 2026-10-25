import type { RendererFactory, RendererHandle } from '@vector-studio/react';

// P5-U6 (P5 plan, section 6 and P5-Q8): the host's renderer, composed as the V-1 playground page
// composes it: the P1 primitive and P3 path renderer service on the WebGPU backend, with the
// fill-mesh and stroke-mesh ports from geometry-wasm. Every renderer module is loaded by dynamic
// `import()` inside the factory, which runs only in the canvas effect, so nothing here is
// evaluated during prerender. Precision stays UNVERIFIED until P3 A04 evidence exists.

const WASM_URL = '/geometry-kernel.wasm';

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
  // Two instances of the one kernel: each port owns its own linear memory.
  const fill = await geometry.createFillMeshPort(bytes);
  const stroke = await geometry.createStrokeMeshPort(bytes);
  const backend = new webgpu.WebGpuBackend();
  const service = new core.PrimitiveRendererService(backend, {
    fillMesh: fill,
    fillMeshMemoryBytes: () => fill.linearMemoryBytes(),
    strokeMesh: stroke,
    strokeMeshMemoryBytes: () => stroke.linearMemoryBytes(),
  });
  const source = backend.attachPrimitiveFrameSource(service);
  const capability = await backend.initialize({
    canvas,
    cssSize: { width: size.width, height: size.height },
    devicePixelRatio: size.devicePixelRatio,
  });
  const dispose = () => {
    source.dispose();
    service.dispose();
    backend.dispose();
  };
  if (!capability.supported) {
    dispose();
    throw new Error(`WebGPU is not available: ${capability.diagnostic.message}`);
  }
  const handle: RendererHandle = { renderer: service, dispose };
  return handle;
};
