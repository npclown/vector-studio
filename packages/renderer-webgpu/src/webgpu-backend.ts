import {
  DIAGNOSTIC_CODES,
  type DiagnosticCode,
  type DiagnosticContext,
  type DiagnosticListener,
  type Disposable,
  type PixelSize,
  type RendererCapabilities,
  type RendererCapabilityResult,
  type RendererDiagnostic,
  type RendererInvalidation,
  type RendererInvalidationTarget,
  type RendererLifecycle,
  type RendererLifecycleState,
  type RendererStatistics,
  type RendererMode,
  type RendererSurfaceSize,
} from '@vector-studio/contracts';
import {
  DiagnosticChannel,
  FrameScheduler,
  ResourceAccounting,
  type AnimationFrameClock,
  type DiagnosticClock,
} from '@vector-studio/renderer-core';

import { computeSurfaceSize } from './surface-size.js';
import {
  createBrowserWebGpuPlatform,
  type WebGpuCanvasContextPort,
  type WebGpuDevicePort,
  type WebGpuFoundationScenePort,
  type WebGpuPlatform,
} from './webgpu-platform.js';

export interface WebGpuSurface {
  readonly canvas: HTMLCanvasElement;
  readonly cssSize: PixelSize;
  readonly devicePixelRatio: number;
}

export interface WebGpuBackendOptions {
  readonly animationFrameClock?: AnimationFrameClock;
  readonly clock?: DiagnosticClock;
  readonly now?: () => number;
  readonly platform?: WebGpuPlatform;
}

export interface WebGpuFrameMeasurements {
  readonly encodeAndSubmitMs: readonly number[];
  readonly frameIntervalsMs: readonly number[];
}

function errorContext(error: unknown): DiagnosticContext {
  if (error instanceof Error) {
    return Object.freeze({ errorName: error.name, errorMessage: error.message });
  }
  return Object.freeze({ errorMessage: String(error) });
}

export class WebGpuBackend implements RendererLifecycle<WebGpuSurface>, RendererInvalidationTarget {
  readonly #diagnostics: DiagnosticChannel;
  readonly #platform: WebGpuPlatform;
  readonly #resources = new ResourceAccounting();
  readonly #scheduler: FrameScheduler;
  readonly #now: () => number;
  #capabilityResult: RendererCapabilityResult | undefined;
  #canvas: HTMLCanvasElement | undefined;
  #context: WebGpuCanvasContextPort | undefined;
  #device: WebGpuDevicePort | undefined;
  #scene: WebGpuFoundationScenePort | undefined;
  #invalidationsRequested = 0;
  #framesSubmitted = 0;
  #framesPresented = 0;
  #shaderModulesCreated = 0;
  #pipelinesCreated = 0;
  #encodeAndSubmitMs: number[] = [];
  #frameIntervalsMs: number[] = [];
  #lastFrameTimestampMs: number | undefined;
  #generation = 0;
  #initialization: Promise<RendererCapabilityResult> | undefined;
  #operationToken = 0;
  #presentationFormat: string | undefined;
  #state: RendererLifecycleState = 'idle';
  #surfaceRevision = 0;
  #surfaceSize: RendererSurfaceSize | undefined;

  constructor(options: WebGpuBackendOptions = {}) {
    this.#diagnostics = new DiagnosticChannel(
      options.clock === undefined ? {} : { clock: options.clock },
    );
    this.#platform = options.platform ?? createBrowserWebGpuPlatform();
    this.#now = options.now ?? (() => performance.now());
    this.#scheduler = new FrameScheduler({
      ...(options.animationFrameClock === undefined ? {} : { clock: options.animationFrameClock }),
      render: (timestampMs) => this.#render(timestampMs),
    });
  }

  get state(): RendererLifecycleState {
    return this.#state;
  }

  get generation(): number {
    return this.#generation;
  }

  get presentationFormat(): string | undefined {
    return this.#presentationFormat;
  }

  get surfaceRevision(): number {
    return this.#surfaceRevision;
  }

  get surfaceSize(): RendererSurfaceSize | undefined {
    return this.#surfaceSize;
  }

  subscribeDiagnostics(listener: DiagnosticListener): Disposable {
    return this.#diagnostics.subscribe(listener);
  }

  initialize(surface: WebGpuSurface): Promise<RendererCapabilityResult> {
    if (this.#state === 'disposed') {
      return Promise.resolve(
        this.#failure(
          DIAGNOSTIC_CODES.INITIALIZATION_AFTER_DISPOSE,
          'Initialization was requested after disposal.',
          'error',
          this.#generation,
        ),
      );
    }
    if (this.#state === 'ready' && this.#capabilityResult) {
      return Promise.resolve(this.#capabilityResult);
    }
    if (this.#initialization) {
      return this.#initialization;
    }

    this.#state = 'initializing';
    const token = ++this.#operationToken;
    const generation = this.#generation + 1;
    const initialization = this.#initializeAttempt(surface, token, generation);
    this.#initialization = initialization;
    void initialization.then(() => {
      if (this.#initialization === initialization) {
        this.#initialization = undefined;
      }
    });
    return initialization;
  }

  resize(cssSize: PixelSize, devicePixelRatio: number): RendererSurfaceSize {
    if (this.#state !== 'ready' || !this.#canvas || !this.#surfaceSize) {
      throw new Error('The backend must be ready before resize.');
    }

    const maxDimension = this.#capabilityResult?.supported
      ? this.#capabilityResult.capabilities.limits.maxTextureDimension2D
      : undefined;
    if (maxDimension === undefined) {
      throw new Error('The device did not report maxTextureDimension2D.');
    }

    const previousRevision = this.#surfaceRevision;
    const size = this.#applySurfaceSize(this.#canvas, cssSize, devicePixelRatio, maxDimension);
    if (this.#surfaceRevision !== previousRevision) {
      this.#resizeScene(size.physical);
      this.invalidate({ reason: 'resize', sourceRevision: this.#surfaceRevision });
    }
    return size;
  }

  invalidate(invalidation: RendererInvalidation): void {
    void invalidation;
    if (this.#state !== 'ready') {
      return;
    }
    this.#invalidationsRequested += 1;
    this.#scheduler.invalidate();
  }

  setMode(mode: RendererMode): void {
    this.#scheduler.setMode(mode);
  }

  resetFrameMeasurements(): void {
    this.#encodeAndSubmitMs = [];
    this.#frameIntervalsMs = [];
    this.#lastFrameTimestampMs = undefined;
  }

  getFrameMeasurements(): WebGpuFrameMeasurements {
    return Object.freeze({
      encodeAndSubmitMs: Object.freeze([...this.#encodeAndSubmitMs]),
      frameIntervalsMs: Object.freeze([...this.#frameIntervalsMs]),
    });
  }

  getStatistics(): RendererStatistics {
    return Object.freeze({
      lifecycle: this.#state,
      generation: this.#generation,
      mode: this.#scheduler.mode,
      invalidationsRequested: this.#invalidationsRequested,
      framesSubmitted: this.#framesSubmitted,
      framesPresented: this.#framesPresented,
      pendingFrameCallbacks: this.#scheduler.pendingCallbacks,
      shaderModulesCreated: this.#shaderModulesCreated,
      pipelinesCreated: this.#pipelinesCreated,
      resources: this.#resources.snapshot(),
    });
  }

  dispose(): void {
    if (this.#state === 'disposed') {
      return;
    }

    this.#operationToken += 1;
    this.#state = 'disposed';
    this.#scheduler.dispose();

    try {
      this.#scene?.dispose();
      this.#context?.unconfigure();
      this.#device?.destroy();
    } catch (error: unknown) {
      this.#emit(
        DIAGNOSTIC_CODES.DISPOSAL_FAILED,
        'A WebGPU resource failed during disposal.',
        'error',
        this.#generation,
        errorContext(error),
      );
    }

    this.#context = undefined;
    this.#device = undefined;
    this.#scene = undefined;
    this.#canvas = undefined;
    this.#surfaceSize = undefined;
    this.#presentationFormat = undefined;
    this.#capabilityResult = undefined;
    this.#resources.clear();
    this.#emit(
      DIAGNOSTIC_CODES.DISPOSAL_COMPLETED,
      'WebGPU backend disposal completed.',
      'info',
      this.#generation,
    );
    this.#diagnostics.clear();
  }

  async #initializeAttempt(
    surface: WebGpuSurface,
    token: number,
    generation: number,
  ): Promise<RendererCapabilityResult> {
    if (!this.#platform.secureContext) {
      return this.#unsupported(
        DIAGNOSTIC_CODES.INSECURE_CONTEXT,
        'WebGPU requires a secure context.',
        token,
        generation,
      );
    }
    if (!this.#platform.apiAvailable) {
      return this.#unsupported(
        DIAGNOSTIC_CODES.API_UNAVAILABLE,
        'The WebGPU API is unavailable.',
        token,
        generation,
      );
    }

    let context: WebGpuCanvasContextPort | null;
    try {
      context = this.#platform.getCanvasContext(surface.canvas);
    } catch (error: unknown) {
      return this.#failed(
        DIAGNOSTIC_CODES.SURFACE_CONFIGURATION_FAILED,
        'The canvas context request failed.',
        token,
        generation,
        errorContext(error),
      );
    }
    if (!context) {
      return this.#unsupported(
        DIAGNOSTIC_CODES.CANVAS_CONTEXT_UNAVAILABLE,
        'The canvas did not provide a WebGPU context.',
        token,
        generation,
      );
    }

    let adapter;
    try {
      adapter = await this.#platform.requestAdapter();
    } catch (error: unknown) {
      return this.#failed(
        DIAGNOSTIC_CODES.ADAPTER_REQUEST_FAILED,
        'The WebGPU adapter request failed.',
        token,
        generation,
        errorContext(error),
      );
    }
    if (!this.#isCurrent(token)) {
      return this.#stale(generation);
    }
    if (!adapter) {
      return this.#unsupported(
        DIAGNOSTIC_CODES.ADAPTER_UNAVAILABLE,
        'No WebGPU adapter is available.',
        token,
        generation,
      );
    }

    let device: WebGpuDevicePort;
    try {
      device = await adapter.requestDevice();
    } catch (error: unknown) {
      return this.#failed(
        DIAGNOSTIC_CODES.DEVICE_REQUEST_FAILED,
        'The WebGPU device request failed.',
        token,
        generation,
        errorContext(error),
      );
    }
    if (!this.#isCurrent(token)) {
      device.destroy();
      return this.#stale(generation);
    }

    const maxTextureDimension2D = device.limits.maxTextureDimension2D;
    if (maxTextureDimension2D === undefined) {
      device.destroy();
      return this.#failed(
        DIAGNOSTIC_CODES.DEVICE_REQUEST_FAILED,
        'The device did not expose maxTextureDimension2D.',
        token,
        generation,
      );
    }

    let format: string;
    try {
      format = this.#platform.getPreferredCanvasFormat();
      this.#applySurfaceSize(
        surface.canvas,
        surface.cssSize,
        surface.devicePixelRatio,
        maxTextureDimension2D,
      );
      context.configure({ device, format, alphaMode: 'premultiplied' });
    } catch (error: unknown) {
      device.destroy();
      return this.#failed(
        DIAGNOSTIC_CODES.SURFACE_CONFIGURATION_FAILED,
        'The WebGPU canvas configuration failed.',
        token,
        generation,
        errorContext(error),
      );
    }
    if (!this.#isCurrent(token)) {
      context.unconfigure();
      device.destroy();
      return this.#stale(generation);
    }

    let foundation;
    try {
      foundation = await device.createFoundationScene(format);
    } catch (error: unknown) {
      context.unconfigure();
      device.destroy();
      return this.#failed(
        DIAGNOSTIC_CODES.FOUNDATION_SCENE_FAILED,
        'The WebGPU foundation scene could not be created.',
        token,
        generation,
        errorContext(error),
      );
    }
    if (!this.#isCurrent(token)) {
      foundation.scene.dispose();
      context.unconfigure();
      device.destroy();
      return this.#stale(generation);
    }

    this.#scene = foundation.scene;
    this.#resizeScene(this.#surfaceSize?.physical ?? { width: 0, height: 0 });
    this.#shaderModulesCreated += foundation.scene.shaderModulesCreated;
    this.#pipelinesCreated += foundation.scene.pipelinesCreated;
    this.#resources.track(`shader-${generation}`, { category: 'shader-module' });
    for (let index = 0; index < foundation.scene.pipelinesCreated; index += 1) {
      this.#resources.track(`pipeline-${generation}-${index}`, { category: 'render-pipeline' });
    }
    if (foundation.fellBackFrom4x) {
      this.#emit(
        DIAGNOSTIC_CODES.MSAA_FALLBACK,
        '4x MSAA was unavailable; the foundation scene uses 1x sampling.',
        'warning',
        generation,
        Object.freeze({ requestedSampleCount: 4, selectedSampleCount: 1 }),
      );
    }

    const capabilities: RendererCapabilities = Object.freeze({
      backend: 'webgpu',
      adapter: Object.freeze({ ...adapter.info }),
      selectedFeatures: Object.freeze([...device.features]),
      limits: Object.freeze({ ...device.limits }),
      sampleCount: foundation.scene.sampleCount,
    });
    const result: RendererCapabilityResult = Object.freeze({ supported: true, capabilities });

    this.#canvas = surface.canvas;
    this.#context = context;
    this.#device = device;
    this.#generation = generation;
    this.#presentationFormat = format;
    this.#capabilityResult = result;
    this.#state = 'ready';
    this.invalidate({ reason: 'initialization' });
    return result;
  }

  #render(timestampMs: number): void {
    if (
      this.#state !== 'ready' ||
      !this.#scene ||
      !this.#context ||
      this.#surfaceSize?.suspended !== false
    ) {
      return;
    }

    if (this.#lastFrameTimestampMs !== undefined) {
      this.#frameIntervalsMs.push(timestampMs - this.#lastFrameTimestampMs);
    }
    this.#lastFrameTimestampMs = timestampMs;

    const startedMs = this.#now();
    try {
      this.#scene.render(this.#context);
      this.#framesSubmitted += 1;
      this.#framesPresented += 1;
      this.#encodeAndSubmitMs.push(this.#now() - startedMs);
    } catch (error: unknown) {
      this.#emit(
        DIAGNOSTIC_CODES.RENDER_SUBMISSION_FAILED,
        'The foundation frame submission failed.',
        'error',
        this.#generation,
        errorContext(error),
      );
    }
  }

  #resizeScene(size: PixelSize): void {
    if (!this.#scene) {
      return;
    }
    this.#resources.release('foundation-attachment');
    this.#scene.resize(size);
    if (this.#scene.attachmentBytes > 0 && size.width > 0 && size.height > 0) {
      this.#resources.track('foundation-attachment', {
        category: 'texture',
        dimension: '2d',
        width: size.width,
        height: size.height,
        depthOrArrayLayers: 1,
        mipLevelCount: 1,
        sampleCount: this.#scene.sampleCount,
        bytesPerTexel: 4,
      });
    }
  }

  #applySurfaceSize(
    canvas: HTMLCanvasElement,
    cssSize: PixelSize,
    devicePixelRatio: number,
    maxTextureDimension2D: number,
  ): RendererSurfaceSize {
    const size = computeSurfaceSize(cssSize, devicePixelRatio, maxTextureDimension2D);
    const previous = this.#surfaceSize;
    const changed =
      previous === undefined ||
      previous.physical.width !== size.physical.width ||
      previous.physical.height !== size.physical.height ||
      previous.devicePixelRatio !== size.devicePixelRatio ||
      previous.css.width !== size.css.width ||
      previous.css.height !== size.css.height;

    if (changed) {
      canvas.width = size.physical.width;
      canvas.height = size.physical.height;
      this.#surfaceRevision += 1;
    }
    this.#surfaceSize = size;
    return size;
  }

  #isCurrent(token: number): boolean {
    return this.#state !== 'disposed' && this.#operationToken === token;
  }

  #unsupported(
    code: DiagnosticCode,
    message: string,
    token: number,
    generation: number,
  ): RendererCapabilityResult {
    const result = this.#failure(code, message, 'error', generation);
    if (this.#isCurrent(token)) {
      this.#state = 'unsupported';
      this.#capabilityResult = result;
    }
    return result;
  }

  #failed(
    code: DiagnosticCode,
    message: string,
    token: number,
    generation: number,
    context?: DiagnosticContext,
  ): RendererCapabilityResult {
    const result = this.#failure(code, message, 'error', generation, context);
    if (this.#isCurrent(token)) {
      this.#state = 'failed';
      this.#capabilityResult = result;
    }
    return result;
  }

  #stale(generation: number): RendererCapabilityResult {
    return this.#failure(
      DIAGNOSTIC_CODES.STALE_INITIALIZATION_IGNORED,
      'A stale initialization completion was ignored.',
      'warning',
      generation,
    );
  }

  #failure(
    code: DiagnosticCode,
    message: string,
    severity: 'warning' | 'error',
    generation: number,
    context?: DiagnosticContext,
  ): RendererCapabilityResult {
    return Object.freeze({
      supported: false,
      diagnostic: this.#emit(code, message, severity, generation, context),
    });
  }

  #emit(
    code: DiagnosticCode,
    message: string,
    severity: 'info' | 'warning' | 'error',
    generation: number,
    context?: DiagnosticContext,
  ): RendererDiagnostic {
    return this.#diagnostics.emit({
      code,
      message,
      severity,
      generation,
      ...(context === undefined ? {} : { context }),
    });
  }
}
