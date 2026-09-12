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
  setTarget(target: PrimitiveTarget): void;
  submitPrimitivePacket: PrimitivePacketConsumer['submitPrimitivePacket'];
  dispose(): void;
}

export interface WebGpuPrimitiveSceneResult {
  readonly scene: WebGpuPrimitiveScenePort;
  readonly fellBackFrom4x: boolean;
}

export interface WebGpuPrimitiveSceneCreationPort {
  readonly result: Promise<WebGpuPrimitiveSceneResult>;
  dispose(): void;
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
}

export interface WebGpuCanvasContextPort {
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
  ): WebGpuPrimitiveSceneCreationPort {
    return createNativePrimitiveSceneCreation(this.native, context, format, generation, resources);
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
  constructor(readonly native: GPUCanvasContext) {}

  configure(configuration: WebGpuCanvasConfiguration): void {
    if (!(configuration.device instanceof BrowserDevicePort)) {
      throw new TypeError('Browser canvas context requires a browser device port.');
    }

    this.native.configure({
      device: configuration.device.native,
      format: configuration.format as GPUTextureFormat,
      alphaMode: configuration.alphaMode,
      colorSpace: 'srgb',
    });
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
