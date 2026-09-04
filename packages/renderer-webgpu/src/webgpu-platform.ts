import type {
  Disposable,
  PixelSize,
  RendererAdapterInfo,
  ResourceDescriptor,
} from '@vector-studio/contracts';

const FOUNDATION_SHADER = /* wgsl */ `
struct VertexOutput {
  @builtin(position) position: vec4f,
  @location(0) color: vec3f,
};

@vertex
fn vertexMain(@location(0) position: vec2f, @location(1) color: vec3f) -> VertexOutput {
  var output: VertexOutput;
  output.position = vec4f(position, 0.0, 1.0);
  output.color = color;
  return output;
}

@fragment
fn fragmentMain(input: VertexOutput) -> @location(0) vec4f {
  return vec4f(input.color, 1.0);
}
`;

const RENDER_ATTACHMENT_USAGE = 0x10;
const VERTEX_BUFFER_USAGE = 0x20;
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
  resize(size: PixelSize): void;
  render(context: WebGpuCanvasContextPort): void;
  dispose(): void;
}

export interface WebGpuFoundationSceneResult {
  readonly scene: WebGpuFoundationScenePort;
  readonly fellBackFrom4x: boolean;
}

export interface WebGpuDevicePort {
  readonly features: readonly string[];
  readonly limits: Readonly<Record<string, number>>;
  readonly lost: Promise<WebGpuDeviceLoss>;
  createFoundationScene(format: string): Promise<WebGpuFoundationSceneResult>;
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

  async createFoundationScene(format: string): Promise<WebGpuFoundationSceneResult> {
    const vertices = new Float32Array([
      0, 0.65, 0.35, 0.75, 1, -0.6, -0.55, 0.68, 0.35, 1, 0.6, -0.55, 1, 0.42, 0.55,
    ]);
    const vertexBuffer = this.native.createBuffer({
      label: 'vector-studio/foundation-vertices',
      size: vertices.byteLength,
      usage: VERTEX_BUFFER_USAGE,
      mappedAtCreation: true,
    });
    new Float32Array(vertexBuffer.getMappedRange()).set(vertices);
    vertexBuffer.unmap();
    const shader = this.native.createShaderModule({
      label: 'vector-studio/foundation-shader',
      code: FOUNDATION_SHADER,
    });
    const createPipeline = (sampleCount: 1 | 4) =>
      this.native.createRenderPipelineAsync({
        label: `vector-studio/foundation-pipeline-${sampleCount}x`,
        layout: 'auto',
        vertex: {
          module: shader,
          entryPoint: 'vertexMain',
          buffers: [
            {
              arrayStride: 20,
              attributes: [
                { shaderLocation: 0, offset: 0, format: 'float32x2' },
                { shaderLocation: 1, offset: 8, format: 'float32x3' },
              ],
            },
          ],
        },
        fragment: {
          module: shader,
          entryPoint: 'fragmentMain',
          targets: [{ format: format as GPUTextureFormat }],
        },
        primitive: { topology: 'triangle-list' },
        multisample: { count: sampleCount },
      });

    try {
      const pipeline = await createPipeline(4);
      return {
        scene: new BrowserFoundationScene(
          this.native,
          pipeline,
          vertexBuffer,
          vertices.byteLength,
          format,
          4,
          1,
        ),
        fellBackFrom4x: false,
      };
    } catch {
      try {
        const pipeline = await createPipeline(1);
        return {
          scene: new BrowserFoundationScene(
            this.native,
            pipeline,
            vertexBuffer,
            vertices.byteLength,
            format,
            1,
            1,
          ),
          fellBackFrom4x: true,
        };
      } catch (error: unknown) {
        vertexBuffer.destroy();
        throw error;
      }
    }
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

class BrowserFoundationScene implements WebGpuFoundationScenePort {
  readonly shaderModulesCreated = 1;
  readonly #device: GPUDevice;
  readonly #pipeline: GPURenderPipeline;
  readonly #vertexBuffer: GPUBuffer;
  readonly #format: string;
  readonly sampleCount: 1 | 4;
  readonly pipelinesCreated: number;
  readonly staticResources: readonly WebGpuTrackedResource[];
  #attachment: GPUTexture | undefined;
  #attachmentBytes = 0;

  constructor(
    device: GPUDevice,
    pipeline: GPURenderPipeline,
    vertexBuffer: GPUBuffer,
    vertexBufferBytes: number,
    format: string,
    sampleCount: 1 | 4,
    pipelinesCreated: number,
  ) {
    this.#device = device;
    this.#pipeline = pipeline;
    this.#vertexBuffer = vertexBuffer;
    this.#format = format;
    this.sampleCount = sampleCount;
    this.pipelinesCreated = pipelinesCreated;
    this.staticResources = Object.freeze([
      {
        id: 'foundation-vertices',
        descriptor: { category: 'buffer', size: vertexBufferBytes },
      },
      { id: 'foundation-shader', descriptor: { category: 'shader-module' } },
      { id: 'foundation-pipeline', descriptor: { category: 'render-pipeline' } },
    ] satisfies WebGpuTrackedResource[]);
  }

  get attachmentBytes(): number {
    return this.#attachmentBytes;
  }

  resize(size: PixelSize): void {
    this.#attachment?.destroy();
    this.#attachment = undefined;
    this.#attachmentBytes = 0;
    if (this.sampleCount === 1 || size.width === 0 || size.height === 0) {
      return;
    }

    this.#attachment = this.#device.createTexture({
      label: 'vector-studio/foundation-msaa-color',
      size: { width: size.width, height: size.height },
      sampleCount: this.sampleCount,
      format: this.#format as GPUTextureFormat,
      usage: RENDER_ATTACHMENT_USAGE,
    });
    this.#attachmentBytes = size.width * size.height * 4 * this.sampleCount;
  }

  render(context: WebGpuCanvasContextPort): void {
    if (!(context instanceof BrowserCanvasContextPort)) {
      throw new TypeError('Browser foundation scene requires a browser canvas context.');
    }

    const presentationView = context.native.getCurrentTexture().createView();
    const multisampleView = this.#attachment?.createView();
    const encoder = this.#device.createCommandEncoder({
      label: 'vector-studio/foundation-frame',
    });
    const pass = encoder.beginRenderPass({
      label: 'vector-studio/foundation-pass',
      colorAttachments: [
        {
          view: multisampleView ?? presentationView,
          ...(multisampleView === undefined ? {} : { resolveTarget: presentationView }),
          clearValue: { r: 0.035, g: 0.055, b: 0.1, a: 1 },
          loadOp: 'clear',
          storeOp: multisampleView === undefined ? 'store' : 'discard',
        },
      ],
    });
    pass.setPipeline(this.#pipeline);
    pass.setVertexBuffer(0, this.#vertexBuffer);
    pass.draw(3);
    pass.end();
    this.#device.queue.submit([encoder.finish()]);
  }

  dispose(): void {
    this.#attachment?.destroy();
    this.#attachment = undefined;
    this.#attachmentBytes = 0;
    this.#vertexBuffer.destroy();
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
