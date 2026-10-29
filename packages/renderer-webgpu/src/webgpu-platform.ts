import type {
  Disposable,
  PixelSize,
  RendererAdapterInfo,
  ResourceDescriptor,
} from '@vector-studio/contracts';
import type { PrimitivePacketConsumer, PrimitiveTarget } from '@vector-studio/renderer-core';
import type { FoundationBindingSource } from './foundation-experiment.js';
import { createNativeFoundationSceneCreation } from './native-foundation-scene.js';
import { createNativePrimitiveSceneCreation } from './native-primitive-scene.js';

const COPY_SOURCE_AND_DESTINATION_USAGE = 0x0c;
const RENDER_ATTACHMENT_USAGE = 0x10;

export type WebGpuDeviceErrorType = 'validation' | 'out-of-memory' | 'internal' | 'unknown';

export interface WebGpuDeviceError {
  readonly type: WebGpuDeviceErrorType;
  readonly message: string;
}

export interface WebGpuDeviceLoss {
  readonly reason: string;
  readonly message: string;
}

export interface WebGpuTrackedResource {
  readonly id: string;
  readonly descriptor: ResourceDescriptor;
}

export interface WebGpuFoundationScenePort {
  readonly sampleCount: 1 | 4;
  readonly shaderModulesCreated: number;
  readonly pipelinesCreated: number;
  readonly attachmentBytes: number;
  readonly staticResources: readonly WebGpuTrackedResource[];
  resize(size: PixelSize, devicePixelRatio: number): void;
  render(context: WebGpuCanvasContextPort): void;
  dispose(): void;
}

export interface WebGpuFoundationSceneResult {
  readonly scene: WebGpuFoundationScenePort;
  readonly fellBackFrom4x: boolean;
}

export interface WebGpuFoundationSceneCreationPort {
  readonly result: Promise<WebGpuFoundationSceneResult>;
  /** Promptly releases attempt-owned resources; implementations must be idempotent. */
  dispose(): void;
}

export interface WebGpuResourceTracker {
  track(id: string, descriptor: ResourceDescriptor): void;
  release(id: string): void;
}

export interface WebGpuPrimitiveScenePort extends PrimitivePacketConsumer {
  readonly sampleCount: 1 | 4;
  readonly shaderModulesCreated: number;
  readonly pipelinesCreated: number;
  /**
   * P3 V3 section f: true when this generation created the mesh pipeline. Absent or false means
   * the mesh path is unavailable: mesh draws and writes are skipped with a skipped mesh receipt.
   */
  readonly meshPipelineAvailable?: boolean;
  /**
   * P4 contract, U3: true when this generation created the rect-clip pipeline variants. Absent
   * or false: a draw with a clip state is not drawn.
   */
  readonly clipPipelineAvailable?: boolean;
  /**
   * E23 contract, U3: true when this generation created the gradient paint pipeline variants.
   * Absent or false: a draw with a gradient paint is not drawn.
   */
  readonly paintPipelineAvailable?: boolean;
  /** P4 contract, U4 (Mask cache): the mask passes this generation has run. */
  readonly maskPasses?: number;
  /**
   * E25 contract, U3: true when this generation created the layer variants and the composite
   * pipeline. Absent or false: the content of isolated containers is not drawn.
   */
  readonly layerPipelineAvailable?: boolean;
  /** E25 contract, section 4, Lifetime: the layer passes this generation has run, per layer. */
  readonly layerPasses?: number;
  /**
   * E28 contract, U3: true when this generation created the text pipelines and the sampler.
   * Absent or false: text is not drawn.
   */
  readonly textPipelineAvailable?: boolean;
  /** E28-D1: true once an atlas page could not be created; text stays undrawn. */
  readonly textPageAllocationFailed?: boolean;
  setTarget(target: PrimitiveTarget): void;
  submitPrimitivePacket: PrimitivePacketConsumer['submitPrimitivePacket'];
  /**
   * @internal Tests only (E10 contract, section 3.2): arms the copy, and the count pass when
   * requested, for the next submitPrimitivePacket call, which always settles the request.
   */
  captureNextSubmissionForTesting?(request: WebGpuSceneCaptureRequestForTesting): void;
  dispose(): void;
}

/** @internal Tests only (E10 contract, section 4): the scene's part of a frame capture. */
export interface WebGpuSceneCaptureForTesting {
  readonly generation: number;
  readonly surfaceRevision: number;
  readonly cameraRevision: number;
  readonly width: number;
  readonly height: number;
  readonly sampleCount: 1 | 4;
  readonly targetFormat: 'bgra8unorm' | 'rgba8unorm';
  /** R, G, B, A bytes, rows top first, tightly packed, swizzled from bgra8unorm. */
  readonly rgba: Uint8Array;
  readonly meshDraws: readonly Readonly<{
    instance: number;
    firstTriangle: number;
    triangleCount: number;
    composite: 'plain' | 'joint-fill';
  }>[];
  /** `samples` integer counts per pixel, in sample index order (section 5). */
  readonly counts?: Readonly<{ samples: 1 | 4; data: Uint16Array }>;
}

/** @internal Tests only (E10 contract, section 4). */
export interface WebGpuSceneCaptureRequestForTesting {
  readonly counts: boolean;
  /** Called once the copy is encoded into the frame's submission. */
  encoded(): void;
  resolve(capture: WebGpuSceneCaptureForTesting): void;
  /** The error message starts with a section 4 code. */
  reject(error: Error): void;
}

export interface WebGpuPrimitiveSceneResult {
  readonly scene: WebGpuPrimitiveScenePort;
  readonly fellBackFrom4x: boolean;
}

export interface WebGpuPrimitiveSceneCreationPort {
  readonly result: Promise<WebGpuPrimitiveSceneResult>;
  dispose(): void;
}

/** Creation options; the mesh pipeline is created with the P1 pipeline, never on the frame path. */
export interface WebGpuPrimitiveSceneOptions {
  readonly meshPipeline?: boolean;
  /**
   * P4 contract, U3: creates the rect-clip pipeline variants (the analytic one, and the mesh
   * ones with the mesh pipeline). Without them a clipped draw is not drawn (fail closed).
   */
  readonly clipPipeline?: boolean;
  /**
   * E23 contract, U3: creates the gradient paint pipeline variants (the analytic one, the mesh
   * ones with the mesh pipeline, and each with the clip block with the clip variants). Without
   * them a draw with a gradient paint is not drawn (fail closed).
   */
  readonly paintPipeline?: boolean;
  /**
   * E25 contract, U3: creates the layer pipeline variants of every variant the generation has
   * (section 4, Layer pipeline variants) and the composite pipeline. It needs the adapter's
   * `maxBindGroups` of at least 4; without it the layer pipeline is unavailable.
   */
  readonly layerPipeline?: boolean;
  /**
   * E28 contract, U3: creates the text pipeline with its clip and layer variants (as the
   * generation has the clip and layer variants) and the sampler. Without it text is not drawn.
   */
  readonly textPipeline?: boolean;
  /**
   * @internal Tests only (E25 contract, section 4): the layer tile edge instead of 1024; a
   * positive even integer.
   */
  readonly layerTileSizeForTesting?: number;
  /**
   * @internal Tests only (E10 contract, section 3.2): a forced sample count. 4 fails creation
   * when a 4x pipeline is unavailable; 1 creates 1x only. Absent: try 4x, then fall back.
   */
  readonly sampleCount?: 1 | 4;
  /** @internal Tests only (E10 contract, section 5): creates the count pipelines. */
  readonly countPass?: boolean;
}

export interface WebGpuDevicePort {
  readonly features: readonly string[];
  readonly limits: Readonly<Record<string, number>>;
  readonly lost: Promise<WebGpuDeviceLoss>;
  createFoundationScene(
    format: string,
    source: FoundationBindingSource,
  ): WebGpuFoundationSceneCreationPort;
  createPrimitiveScene?(
    context: WebGpuCanvasContextPort,
    format: 'bgra8unorm' | 'rgba8unorm',
    generation: number,
    resources: WebGpuResourceTracker,
    options?: WebGpuPrimitiveSceneOptions,
  ): WebGpuPrimitiveSceneCreationPort;
  waitForSubmittedWork(): Promise<void>;
  subscribeErrors(listener: (error: WebGpuDeviceError) => void): Disposable;
  triggerValidationErrorForTesting(): void;
  destroy(): void;
}

export interface WebGpuAdapterPort {
  readonly info: RendererAdapterInfo;
  requestDevice(): Promise<WebGpuDevicePort>;
}

export interface WebGpuCanvasConfiguration {
  readonly device: WebGpuDevicePort;
  readonly format: string;
  readonly alphaMode: 'opaque' | 'premultiplied';
  /** @internal Tests only (E10 contract, section 3.2): passed to configure only when present. */
  readonly usage?: number;
}

export interface WebGpuCanvasContextPort {
  /** @internal Tests only (E10 contract, section 3.2): the usage configure applied, if known. */
  readonly configuredUsage?: number | undefined;
  configure(configuration: WebGpuCanvasConfiguration): void;
  unconfigure(): void;
}

export interface WebGpuPlatform {
  readonly secureContext: boolean;
  readonly apiAvailable: boolean;
  requestAdapter(): Promise<WebGpuAdapterPort | null>;
  getCanvasContext(canvas: HTMLCanvasElement): WebGpuCanvasContextPort | null;
  getPreferredCanvasFormat(): string;
}

function collectLimits(limits: GPUSupportedLimits): Readonly<Record<string, number>> {
  const values: Record<string, number> = {};
  const candidate = limits as unknown as Record<string, unknown>;

  for (const key in candidate) {
    const value = candidate[key];
    if (typeof value === 'number' && Number.isFinite(value)) {
      values[key] = value;
    }
  }

  values.maxTextureDimension2D = limits.maxTextureDimension2D;
  values.maxBufferSize = limits.maxBufferSize;
  return Object.freeze(values);
}

class BrowserDevicePort implements WebGpuDevicePort {
  readonly features: readonly string[];
  readonly limits: Readonly<Record<string, number>>;
  readonly lost: Promise<WebGpuDeviceLoss>;

  constructor(readonly native: GPUDevice) {
    this.features = Object.freeze([...native.features].sort());
    this.limits = collectLimits(native.limits);
    this.lost = native.lost.then(({ message, reason }) =>
      Object.freeze({ message, reason: String(reason) }),
    );
  }

  createFoundationScene(
    format: string,
    source: FoundationBindingSource,
  ): WebGpuFoundationSceneCreationPort {
    return createNativeFoundationSceneCreation(this.native, format, source);
  }

  createPrimitiveScene(
    context: WebGpuCanvasContextPort,
    format: 'bgra8unorm' | 'rgba8unorm',
    generation: number,
    resources: WebGpuResourceTracker,
    options?: WebGpuPrimitiveSceneOptions,
  ): WebGpuPrimitiveSceneCreationPort {
    return createNativePrimitiveSceneCreation(
      this.native,
      context,
      format,
      generation,
      resources,
      options,
    );
  }

  waitForSubmittedWork(): Promise<void> {
    return this.native.queue.onSubmittedWorkDone();
  }

  subscribeErrors(listener: (error: WebGpuDeviceError) => void): Disposable {
    let disposed = false;
    const handler = (event: GPUUncapturedErrorEvent) => {
      const constructorName = event.error.constructor.name;
      const type: WebGpuDeviceErrorType =
        constructorName === 'GPUValidationError'
          ? 'validation'
          : constructorName === 'GPUOutOfMemoryError'
            ? 'out-of-memory'
            : constructorName === 'GPUInternalError'
              ? 'internal'
              : 'unknown';
      listener(Object.freeze({ type, message: event.error.message }));
    };
    this.native.addEventListener('uncapturederror', handler);
    return {
      get disposed() {
        return disposed;
      },
      dispose: () => {
        if (disposed) return;
        disposed = true;
        this.native.removeEventListener('uncapturederror', handler);
      },
    };
  }

  triggerValidationErrorForTesting(): void {
    const buffer = this.native.createBuffer({
      label: 'vector-studio/test-overlapping-copy-buffer',
      size: 4,
      usage: COPY_SOURCE_AND_DESTINATION_USAGE,
    });
    const encoder = this.native.createCommandEncoder({
      label: 'vector-studio/test-invalid-command-encoder',
    });
    encoder.copyBufferToBuffer(buffer, 0, buffer, 0, 4);
    encoder.finish();
    this.native.queue.submit([]);
    buffer.destroy();
  }

  destroy(): void {
    this.native.destroy();
  }
}

class BrowserAdapterPort implements WebGpuAdapterPort {
  readonly info: RendererAdapterInfo;

  constructor(readonly native: GPUAdapter) {
    const { architecture, description, vendor } = native.info;
    this.info = Object.freeze({ architecture, description, vendor });
  }

  async requestDevice(): Promise<WebGpuDevicePort> {
    return new BrowserDevicePort(await this.native.requestDevice());
  }
}

class BrowserCanvasContextPort implements WebGpuCanvasContextPort {
  #configuredUsage: number | undefined;

  constructor(readonly native: GPUCanvasContext) {}

  get configuredUsage(): number | undefined {
    return this.#configuredUsage;
  }

  configure(configuration: WebGpuCanvasConfiguration): void {
    if (!(configuration.device instanceof BrowserDevicePort)) {
      throw new TypeError('Browser canvas context requires a browser device port.');
    }

    this.native.configure({
      device: configuration.device.native,
      format: configuration.format as GPUTextureFormat,
      alphaMode: configuration.alphaMode,
      colorSpace: 'srgb',
      ...(configuration.usage === undefined ? {} : { usage: configuration.usage }),
    });
    // The WebGPU default usage is RENDER_ATTACHMENT.
    this.#configuredUsage = configuration.usage ?? RENDER_ATTACHMENT_USAGE;
  }

  unconfigure(): void {
    this.native.unconfigure();
  }
}

class BrowserWebGpuPlatform implements WebGpuPlatform {
  get secureContext(): boolean {
    return globalThis.isSecureContext;
  }

  get apiAvailable(): boolean {
    return typeof navigator !== 'undefined' && navigator.gpu !== undefined;
  }

  async requestAdapter(): Promise<WebGpuAdapterPort | null> {
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
    return adapter ? new BrowserAdapterPort(adapter) : null;
  }

  getCanvasContext(canvas: HTMLCanvasElement): WebGpuCanvasContextPort | null {
    const context = canvas.getContext('webgpu') as GPUCanvasContext | null;
    return context ? new BrowserCanvasContextPort(context) : null;
  }

  getPreferredCanvasFormat(): string {
    return navigator.gpu.getPreferredCanvasFormat();
  }
}

export function createBrowserWebGpuPlatform(): WebGpuPlatform {
  return new BrowserWebGpuPlatform();
}
