import type { PixelSize, RendererAdapterInfo } from '@vector-studio/contracts';

const FOUNDATION_SHADER = /* wgsl */ `
struct VertexOutput {
  @builtin(position) position: vec4f,
  @location(0) color: vec3f,
};

@vertex
fn vertexMain(@builtin(vertex_index) vertexIndex: u32) -> VertexOutput {
  var positions = array<vec2f, 3>(
    vec2f(0.0, 0.65),
    vec2f(-0.6, -0.55),
    vec2f(0.6, -0.55),
  );
  var colors = array<vec3f, 3>(
    vec3f(0.35, 0.75, 1.0),
    vec3f(0.68, 0.35, 1.0),
    vec3f(1.0, 0.42, 0.55),
  );
  var output: VertexOutput;
  output.position = vec4f(positions[vertexIndex], 0.0, 1.0);
  output.color = colors[vertexIndex];
  return output;
}

@fragment
fn fragmentMain(input: VertexOutput) -> @location(0) vec4f {
  return vec4f(input.color, 1.0);
}
`;

const RENDER_ATTACHMENT_USAGE = 0x10;

export interface WebGpuFoundationScenePort {
  readonly sampleCount: 1 | 4;
  readonly shaderModulesCreated: number;
  readonly pipelinesCreated: number;
  readonly attachmentBytes: number;
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
  createFoundationScene(format: string): Promise<WebGpuFoundationSceneResult>;
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

  async createFoundationScene(format: string): Promise<WebGpuFoundationSceneResult> {
    const shader = this.native.createShaderModule({
      label: 'vector-studio/foundation-shader',
      code: FOUNDATION_SHADER,
    });
    const createPipeline = (sampleCount: 1 | 4) =>
      this.native.createRenderPipelineAsync({
        label: `vector-studio/foundation-pipeline-${sampleCount}x`,
        layout: 'auto',
        vertex: { module: shader, entryPoint: 'vertexMain' },
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
        scene: new BrowserFoundationScene(this.native, pipeline, format, 4, 1),
        fellBackFrom4x: false,
      };
    } catch {
      const pipeline = await createPipeline(1);
      return {
        scene: new BrowserFoundationScene(this.native, pipeline, format, 1, 1),
        fellBackFrom4x: true,
      };
    }
  }

  destroy(): void {
    this.native.destroy();
  }
}

class BrowserFoundationScene implements WebGpuFoundationScenePort {
  readonly shaderModulesCreated = 1;
  readonly #device: GPUDevice;
  readonly #pipeline: GPURenderPipeline;
  readonly #format: string;
  readonly sampleCount: 1 | 4;
  readonly pipelinesCreated: number;
  #attachment: GPUTexture | undefined;
  #attachmentBytes = 0;

  constructor(
    device: GPUDevice,
    pipeline: GPURenderPipeline,
    format: string,
    sampleCount: 1 | 4,
    pipelinesCreated: number,
  ) {
    this.#device = device;
    this.#pipeline = pipeline;
    this.#format = format;
    this.sampleCount = sampleCount;
    this.pipelinesCreated = pipelinesCreated;
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
    pass.draw(3);
    pass.end();
    this.#device.queue.submit([encoder.finish()]);
  }

  dispose(): void {
    this.#attachment?.destroy();
    this.#attachment = undefined;
    this.#attachmentBytes = 0;
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
