import type { RendererAdapterInfo } from '@vector-studio/contracts';

export interface WebGpuDevicePort {
  readonly features: readonly string[];
  readonly limits: Readonly<Record<string, number>>;
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

  constructor(readonly native: GPUDevice) {
    this.features = Object.freeze([...native.features].sort());
    this.limits = collectLimits(native.limits);
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
