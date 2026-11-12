import { DIAGNOSTIC_CODES } from '@vector-studio/contracts';
import type {
  ImageSourcePort,
  RendererDiagnostic,
  RendererSceneSynchronization,
} from '@vector-studio/contracts';
import type {
  PrimitiveRendererService,
  PrimitiveRendererServiceOptions,
} from '@vector-studio/renderer-core';
import type { WebGpuBackend, WebGpuBackendOptions } from '@vector-studio/renderer-webgpu';

// AR-U1 (alpha release plan, docs/plans/alpha-release-plan.md, and ADR 0004): the WebGPU editor
// renderer composition as a package, so a host that installs the packages can draw the canvas.
// It is a host composition root (ARCHITECTURE.md): it obtains the fill and stroke mesh ports from
// geometry-wasm and injects them into renderer-core's service on the renderer-webgpu backend.
// Renderer packages still never import geometry-wasm. It depends on no UI package: the factory it
// returns has the shape of `@vector-studio/react`'s `RendererFactory`, structurally. Every
// renderer module is loaded by dynamic `import()` inside the factory, which a host runs only on
// the client (for example in the canvas effect), so importing this module evaluates no browser
// code during server rendering.

/** The E28 glyph raster port, as the service options type carries it. */
export type EditorGlyphRaster = NonNullable<PrimitiveRendererServiceOptions['glyphRaster']>;

/** The service options the editor needs, without the fill and stroke mesh ports. */
export type EditorRendererOptions = Readonly<
  Required<
    Pick<
      PrimitiveRendererServiceOptions,
      'clips' | 'paints' | 'groups' | 'text' | 'effects' | 'blend'
    >
  > & {
    glyphRaster: EditorGlyphRaster;
    /** V-32 (V32-H1): present with `paints: 'image'`, which needs it. */
    imageSource?: ImageSourcePort;
  }
>;

/**
 * The service options every editor renderer gets: rect and mask clips (P4), gradient paints
 * (E23), isolated groups (E25), atlas text (E28) with the given glyph raster port and node
 * effects (E41-U7, and V-36's inner shadow and background blur: `effects: 'v1'`), so the
 * editor's projected scene draws instead of being isolated as `editor.renderer-unsupported`. A
 * renderer on 'v1' draws E41's kinds exactly as on 'v0' (V36-A05) and scenes without effects
 * exactly as on 'none' (E41-A06), so an editor that projects fewer kinds
 * (`EditorOptions.projectEffects` `true` or off) draws as before. `blend: 'v0'` (V-35, V35-K2)
 * draws node and fill blend modes; a scene without one draws exactly as on 'none' (V35-A06), and
 * a backend that cannot create the blend pipeline reports `blendPipelineAvailable` false and
 * falls back by itself (V35-K7), so an editor that does not project blend modes
 * (`EditorOptions.projectBlend` off) draws as before. With an `imageSource` (V-32,
 * V32-H1: `createImageSource` of `@vector-studio/react`) the paints are `'image'`, gradients and
 * image fills, which an editor created with `projectImages: true` projects; a scene without image
 * paints draws exactly as on 'gradient' (V32-A09).
 */
export function editorRendererOptions(
  glyphRaster: EditorGlyphRaster,
  imageSource?: ImageSourcePort,
): EditorRendererOptions {
  return {
    clips: 'all',
    paints: imageSource === undefined ? 'gradient' : 'image',
    ...(imageSource === undefined ? {} : { imageSource }),
    groups: 'isolated',
    text: 'atlas',
    effects: 'v1',
    blend: 'v0',
    glyphRaster,
  };
}

/**
 * Where the geometry kernel WASM comes from: a URL the page can fetch, its bytes, a compiled
 * `WebAssembly.Module` (compiled once and instantiated for each port; it must come from the
 * page's own realm, not an iframe), or a function that returns one of those.
 */
export type GeometryWasmSource =
  | string
  | URL
  | WebAssembly.Module
  | BufferSource
  | (() => Promise<WebAssembly.Module | BufferSource>);

export type WebGpuRendererCanvasSize = Readonly<{
  width: number;
  height: number;
  devicePixelRatio: number;
}>;

export type WebGpuRendererHandle = Readonly<{
  renderer: RendererSceneSynchronization;
  dispose(): void;
}>;

/** The parts a stage hook receives; the factory owns and disposes all of them. */
export type WebGpuRendererParts = Readonly<{
  backend: WebGpuBackend;
  service: PrimitiveRendererService;
  /** The unwrapped canvas glyph raster port. */
  glyphRaster: EditorGlyphRaster;
  /** The renderer the editor will receive so far: the service, or an earlier stage's wrapper. */
  renderer: RendererSceneSynchronization;
  canvas: HTMLCanvasElement;
  size: WebGpuRendererCanvasSize;
  /**
   * Registers a release for something the stage created. Register each one as soon as it exists:
   * releases run in reverse order on `dispose`, and also when the stage or a later step throws.
   * Call it only while the stage runs: a release added after `dispose` (or a failed run) never runs.
   */
  addRelease(release: () => void): void;
}>;

/**
 * What a stage hook may return: a wrapper around the renderer, and a release for its own state
 * (registered after the stage resolves; prefer `parts.addRelease` so a throwing stage cleans up).
 */
export type WebGpuRendererStageResult = Readonly<{
  renderer?: RendererSceneSynchronization;
  release?: () => void;
}>;

export type WebGpuRendererStage = (
  parts: WebGpuRendererParts,
) => WebGpuRendererStageResult | void | Promise<WebGpuRendererStageResult | void>;

export type WebGpuRendererFactoryOptions = Readonly<{
  /** The geometry kernel WASM. A string or URL is fetched with `fetch`. */
  wasm: GeometryWasmSource;
  /** Options for the WebGPU backend; test-only fields stay test-only. */
  backendOptions?: WebGpuBackendOptions | (() => WebGpuBackendOptions) | undefined;
  /**
   * V-32 (V32-H1): the image source port, for example `createImageSource` of
   * `@vector-studio/react` over the editor's document. With it the service draws image paints
   * (`paints: 'image'`); without it, image fills need `projectImages` off (the editor then
   * projects them as no fill).
   */
  imageSource?: ImageSourcePort | undefined;
  /** Wraps the glyph raster port the editor's service uses (for example to log its calls). */
  wrapGlyphRaster?: ((port: EditorGlyphRaster) => EditorGlyphRaster) | undefined;
  /** Runs after the service exists and before the backend attaches it and initializes. */
  beforeInitialize?: WebGpuRendererStage | undefined;
  /** Runs after the backend initialized with WebGPU available. */
  afterInitialize?: WebGpuRendererStage | undefined;
}>;

/** The geometry kernel WASM could not be loaded. */
export class GeometryWasmUnavailableError extends Error {
  override readonly name = 'GeometryWasmUnavailableError';
}

/**
 * WebGPU is not available on this page. `diagnostic` is the backend's capability diagnostic;
 * the message names the cause and, where there is one, what the host or user can do.
 */
export class WebGpuUnavailableError extends Error {
  override readonly name = 'WebGpuUnavailableError';
  readonly diagnostic: RendererDiagnostic;

  constructor(diagnostic: RendererDiagnostic) {
    super(webGpuUnavailableMessage(diagnostic));
    this.diagnostic = diagnostic;
  }
}

/** The message of a `WebGpuUnavailableError`, with a hint for the common causes. */
export function webGpuUnavailableMessage(diagnostic: RendererDiagnostic): string {
  const base = `WebGPU is not available: ${diagnostic.message}`;
  if (diagnostic.code === DIAGNOSTIC_CODES.INSECURE_CONTEXT) {
    return (
      `${base} Open the page over https:// or from http://localhost (or 127.0.0.1) on the same ` +
      'machine; a network address such as http://192.168.x.x is not a secure context.'
    );
  }
  if (diagnostic.code === DIAGNOSTIC_CODES.API_UNAVAILABLE) {
    return `${base} Use a browser with WebGPU enabled, such as a current Chrome or Edge.`;
  }
  return base;
}

function isBinary(source: unknown): source is WebAssembly.Module | BufferSource {
  // Tag checks rather than `instanceof`, so bytes or modules from another realm are recognized.
  if (ArrayBuffer.isView(source)) return true;
  const tag = Object.prototype.toString.call(source);
  return (
    tag === '[object ArrayBuffer]' ||
    tag === '[object SharedArrayBuffer]' ||
    tag === '[object WebAssembly.Module]'
  );
}

async function loadWasm(source: GeometryWasmSource): Promise<WebAssembly.Module | BufferSource> {
  if (typeof source === 'function') {
    // `WebAssembly.Module` has no members, so `typeof` narrows to `Function` too; a function source
    // is always the loader.
    return (source as () => Promise<WebAssembly.Module | BufferSource>)();
  }
  if (isBinary(source)) return source;
  const url = String(source);
  let response: Response;
  try {
    response = await fetch(url);
  } catch (error) {
    throw new GeometryWasmUnavailableError(
      `The geometry kernel WASM could not be fetched from ${url}.`,
      { cause: error },
    );
  }
  if (!response.ok) {
    throw new GeometryWasmUnavailableError(
      `The geometry kernel WASM is not available at ${url} (HTTP ${String(response.status)}).`,
    );
  }
  return response.arrayBuffer();
}

/**
 * Returns a renderer factory for `EditorCanvas` (`createRenderer`): the editor's WebGPU renderer
 * with the geometry kernel's fill and stroke mesh ports. Each call creates and owns its own
 * kernel instances, backend and service; the handle's `dispose` releases them in reverse order,
 * and a failure releases what was created before it rethrows.
 */
export function createWebGpuRendererFactory(
  options: WebGpuRendererFactoryOptions,
): (canvas: HTMLCanvasElement, size: WebGpuRendererCanvasSize) => Promise<WebGpuRendererHandle> {
  return async (canvas, size) => {
    const [geometry, core, webgpu] = await Promise.all([
      import('@vector-studio/geometry-wasm'),
      import('@vector-studio/renderer-core'),
      import('@vector-studio/renderer-webgpu'),
    ]);
    const loaded = await loadWasm(options.wasm);
    // Compile once; each port instantiates the module with its own linear memory.
    const kernel: WebAssembly.Module =
      loaded instanceof WebAssembly.Module ||
      Object.prototype.toString.call(loaded) === '[object WebAssembly.Module]'
        ? loaded
        : await WebAssembly.compile(loaded);
    const releases: (() => void)[] = [];
    const dispose = () => {
      for (const release of releases.splice(0).reverse()) release();
    };
    try {
      // Two instances of the one kernel: each port owns its own linear memory.
      const fill = await geometry.createFillMeshPort(kernel);
      releases.push(() => fill.dispose());
      const stroke = await geometry.createStrokeMeshPort(kernel);
      releases.push(() => stroke.dispose());
      const backendOptions =
        typeof options.backendOptions === 'function'
          ? options.backendOptions()
          : (options.backendOptions ?? {});
      const backend = new webgpu.WebGpuBackend(backendOptions);
      releases.push(() => backend.dispose());
      const glyphRaster = webgpu.createCanvasGlyphRaster();
      const servicePort = options.wrapGlyphRaster?.(glyphRaster) ?? glyphRaster;
      const service = new core.PrimitiveRendererService(backend, {
        fillMesh: fill,
        fillMeshMemoryBytes: () => fill.linearMemoryBytes(),
        strokeMesh: stroke,
        strokeMeshMemoryBytes: () => stroke.linearMemoryBytes(),
        ...editorRendererOptions(servicePort, options.imageSource),
      });
      releases.push(() => service.dispose());
      let renderer: RendererSceneSynchronization = service;
      const runStage = async (stage: WebGpuRendererStage | undefined) => {
        if (stage === undefined) return;
        const result = await stage({
          backend,
          service,
          glyphRaster,
          renderer,
          canvas,
          size,
          addRelease: (release) => releases.push(release),
        });
        if (result?.release !== undefined) releases.push(result.release);
        if (result?.renderer !== undefined) renderer = result.renderer;
      };
      await runStage(options.beforeInitialize);
      const source = backend.attachPrimitiveFrameSource(service);
      releases.push(() => source.dispose());
      const capability = await backend.initialize({
        canvas,
        cssSize: { width: size.width, height: size.height },
        devicePixelRatio: size.devicePixelRatio,
      });
      if (!capability.supported) throw new WebGpuUnavailableError(capability.diagnostic);
      await runStage(options.afterInitialize);
      return { renderer, dispose };
    } catch (error) {
      dispose();
      throw error;
    }
  };
}
