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
  type RendererLifecycle,
  type RendererLifecycleState,
  type RendererStatistics,
  type RendererSurfaceSize,
} from '@vector-studio/contracts';
import {
  DiagnosticChannel,
  ResourceAccounting,
  type DiagnosticClock,
} from '@vector-studio/renderer-core';

import { computeSurfaceSize } from './surface-size.js';
import {
  createBrowserWebGpuPlatform,
  type WebGpuCanvasContextPort,
  type WebGpuDevicePort,
  type WebGpuPlatform,
} from './webgpu-platform.js';

export interface WebGpuSurface {
  readonly canvas: HTMLCanvasElement;
  readonly cssSize: PixelSize;
  readonly devicePixelRatio: number;
}

export interface WebGpuBackendOptions {
  readonly clock?: DiagnosticClock;
  readonly platform?: WebGpuPlatform;
}

function errorContext(error: unknown): DiagnosticContext {
  if (error instanceof Error) {
    return Object.freeze({ errorName: error.name, errorMessage: error.message });
  }
  return Object.freeze({ errorMessage: String(error) });
}

export class WebGpuBackend implements RendererLifecycle<WebGpuSurface> {
  readonly #diagnostics: DiagnosticChannel;
  readonly #platform: WebGpuPlatform;
  readonly #resources = new ResourceAccounting();
  #capabilityResult: RendererCapabilityResult | undefined;
  #canvas: HTMLCanvasElement | undefined;
  #context: WebGpuCanvasContextPort | undefined;
  #device: WebGpuDevicePort | undefined;
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

    return this.#applySurfaceSize(this.#canvas, cssSize, devicePixelRatio, maxDimension);
  }

  getStatistics(): RendererStatistics {
    return Object.freeze({
      lifecycle: this.#state,
      generation: this.#generation,
      mode: 'on-demand',
      invalidationsRequested: 0,
      framesSubmitted: 0,
      framesPresented: 0,
      shaderModulesCreated: 0,
      pipelinesCreated: 0,
      resources: this.#resources.snapshot(),
    });
  }

  dispose(): void {
    if (this.#state === 'disposed') {
      return;
    }

    this.#operationToken += 1;
    this.#state = 'disposed';

    try {
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

    const capabilities: RendererCapabilities = Object.freeze({
      backend: 'webgpu',
      adapter: Object.freeze({ ...adapter.info }),
      selectedFeatures: Object.freeze([...device.features]),
      limits: Object.freeze({ ...device.limits }),
      sampleCount: 1,
    });
    const result: RendererCapabilityResult = Object.freeze({ supported: true, capabilities });

    this.#canvas = surface.canvas;
    this.#context = context;
    this.#device = device;
    this.#generation = generation;
    this.#presentationFormat = format;
    this.#capabilityResult = result;
    this.#state = 'ready';
    return result;
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
