import type { PixelSize } from '@vector-studio/contracts';

import type { FoundationBindingSource } from './foundation-experiment.js';
import type { SharedBufferAllocation } from './shared-buffer-allocator.js';
import type {
  WebGpuCanvasContextPort,
  WebGpuFoundationSceneCreationPort,
  WebGpuFoundationScenePort,
  WebGpuFoundationSceneResult,
  WebGpuTrackedResource,
} from './webgpu-platform.js';

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
const COPY_DESTINATION_USAGE = 0x08;
const VERTEX_BUFFER_USAGE = 0x20;

interface NativeCanvasContextPort extends WebGpuCanvasContextPort {
  readonly native: GPUCanvasContext;
}

function isNativeCanvasContext(
  context: WebGpuCanvasContextPort,
): context is NativeCanvasContextPort {
  return 'native' in context;
}

function asError(reason: unknown, message: string): Error {
  return reason instanceof Error ? reason : new Error(message, { cause: reason });
}

function pipelineKey(format: string, sampleCount: 1 | 4) {
  return Object.freeze({
    shaderKey: 'foundation-wgsl-v2:vertexMain:fragmentMain:no-overrides',
    layoutKey: 'auto:no-bind-groups',
    vertexLayoutKey: 'slot0:float32x2:stride8;slot1:float32x3:stride12',
    targetFormat: format,
    renderStateKey:
      'triangle-list;ccw;none;no-depth-stencil;blend-disabled;write-mask-all;multisample-mask-all;alpha-to-coverage-false',
    sampleCount,
  });
}

class NativeFoundationScene implements WebGpuFoundationScenePort {
  readonly shaderModulesCreated = 1;
  readonly pipelinesCreated = 1;
  readonly sampleCount: 1 | 4;
  readonly staticResources: readonly WebGpuTrackedResource[];
  readonly #device: GPUDevice;
  readonly #pipeline: GPURenderPipeline;
  readonly #vertexBuffer: GPUBuffer;
  readonly #format: GPUTextureFormat;
  readonly #source: FoundationBindingSource;
  readonly #positions: SharedBufferAllocation;
  readonly #colors: SharedBufferAllocation;
  #attachment: GPUTexture | undefined;
  #attachmentBytes = 0;
  #disposed = false;
  #completionObserverPending = false;
  #latestSubmittedSerial = 0;

  constructor(
    device: GPUDevice,
    pipeline: GPURenderPipeline,
    vertexBuffer: GPUBuffer,
    format: GPUTextureFormat,
    sampleCount: 1 | 4,
    source: FoundationBindingSource,
  ) {
    this.#device = device;
    this.#pipeline = pipeline;
    this.#vertexBuffer = vertexBuffer;
    this.#format = format;
    this.sampleCount = sampleCount;
    this.#source = source;
    const payload = source.payload();
    this.#positions = payload.positions;
    this.#colors = payload.colors;
    this.staticResources = Object.freeze([
      {
        id: 'foundation-vertices',
        descriptor: { category: 'buffer', size: payload.bufferSize },
      },
      { id: 'foundation-shader', descriptor: { category: 'shader-module' } },
      { id: 'foundation-pipeline', descriptor: { category: 'render-pipeline' } },
    ] satisfies WebGpuTrackedResource[]);
  }

  get attachmentBytes(): number {
    return this.#attachmentBytes;
  }

  resize(size: PixelSize, devicePixelRatio: number): void {
    this.#requireActive();
    const positions = this.#source.updateSurface(size, devicePixelRatio);
    const payload = this.#source.payload();
    this.#device.queue.writeBuffer(
      this.#vertexBuffer,
      payload.positions.offset,
      positions,
      0,
      positions.length,
    );

    this.#attachment?.destroy();
    this.#attachment = undefined;
    this.#attachmentBytes = 0;
    if (this.sampleCount === 1 || size.width === 0 || size.height === 0) return;

    this.#attachment = this.#device.createTexture({
      label: 'vector-studio/foundation-msaa-color',
      size: { width: size.width, height: size.height },
      sampleCount: this.sampleCount,
      format: this.#format,
      usage: RENDER_ATTACHMENT_USAGE,
    });
    this.#attachmentBytes = size.width * size.height * 4 * this.sampleCount;
  }

  render(context: WebGpuCanvasContextPort): void {
    this.#requireActive();
    if (!isNativeCanvasContext(context)) {
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
    pass.setVertexBuffer(
      0,
      this.#vertexBuffer,
      this.#positions.offset,
      this.#positions.requestedBytes,
    );
    pass.setVertexBuffer(1, this.#vertexBuffer, this.#colors.offset, this.#colors.requestedBytes);
    pass.draw(3);
    pass.end();
    const commandBuffer = encoder.finish();
    const serial = this.#source.prepareSubmission();
    this.#device.queue.submit([commandBuffer]);
    this.#source.markSubmitted(serial);
    this.#latestSubmittedSerial = serial;
    this.#observeCompletion();
  }

  #observeCompletion(): void {
    if (this.#disposed || this.#completionObserverPending) return;
    const observedSerial = this.#latestSubmittedSerial;
    this.#completionObserverPending = true;
    try {
      const completion = this.#device.queue.onSubmittedWorkDone();
      void completion.then(
        () => {
          this.#completionObserverPending = false;
          if (this.#disposed) return;
          this.#source.completeThrough(observedSerial);
          if (this.#latestSubmittedSerial > observedSerial) this.#observeCompletion();
        },
        () => {
          this.#completionObserverPending = false;
        },
      );
    } catch {
      this.#completionObserverPending = false;
      // A failed observer is not successful completion and cannot advance reuse.
    }
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#source.detach();
    this.#attachment?.destroy();
    this.#attachment = undefined;
    this.#attachmentBytes = 0;
    this.#vertexBuffer.destroy();
    this.#source.recordBackingBufferReleased();
  }

  #requireActive(): void {
    if (this.#disposed) throw new Error('Foundation scene is disposed.');
  }
}

export function createNativeFoundationSceneCreation(
  device: GPUDevice,
  format: string,
  source: FoundationBindingSource,
): WebGpuFoundationSceneCreationPort {
  let buffer: GPUBuffer | undefined;
  let scene: NativeFoundationScene | undefined;
  let disposed = false;
  let bufferRecorded = false;

  const releaseBuffer = () => {
    if (buffer === undefined) return;
    buffer.destroy();
    buffer = undefined;
    if (bufferRecorded) {
      bufferRecorded = false;
      source.recordBackingBufferReleased();
    }
  };
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    source.detach();
    if (scene !== undefined) {
      scene.dispose();
      scene = undefined;
    } else {
      releaseBuffer();
    }
  };

  let result: Promise<WebGpuFoundationSceneResult>;
  try {
    const payload = source.payload();
    buffer = device.createBuffer({
      label: 'vector-studio/foundation-vertices',
      size: payload.bufferSize,
      usage: VERTEX_BUFFER_USAGE | COPY_DESTINATION_USAGE,
    });
    source.recordBackingBufferCreated();
    bufferRecorded = true;
    device.queue.writeBuffer(
      buffer,
      payload.positions.offset,
      payload.positionData,
      0,
      payload.positionData.length,
    );
    device.queue.writeBuffer(
      buffer,
      payload.colors.offset,
      payload.colorData,
      0,
      payload.colorData.length,
    );
    const shader = device.createShaderModule({
      label: 'vector-studio/foundation-shader',
      code: FOUNDATION_SHADER,
    });
    const createPipeline = (sampleCount: 1 | 4) =>
      source.getOrCreatePipeline(pipelineKey(format, sampleCount), () =>
        device.createRenderPipelineAsync({
          label: `vector-studio/foundation-pipeline-${sampleCount}x`,
          layout: 'auto',
          vertex: {
            module: shader,
            entryPoint: 'vertexMain',
            buffers: [
              {
                arrayStride: 8,
                attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x2' }],
              },
              {
                arrayStride: 12,
                attributes: [{ shaderLocation: 1, offset: 0, format: 'float32x3' }],
              },
            ],
          },
          fragment: {
            module: shader,
            entryPoint: 'fragmentMain',
            targets: [{ format: format as GPUTextureFormat }],
          },
          primitive: { topology: 'triangle-list', frontFace: 'ccw', cullMode: 'none' },
          multisample: { count: sampleCount, mask: 0xffffffff, alphaToCoverageEnabled: false },
        }),
      );

    result = (async () => {
      let pipeline: GPURenderPipeline;
      let sampleCount: 1 | 4 = 4;
      let fellBackFrom4x = false;
      try {
        const compatible = [createPipeline(4), createPipeline(4)] as const;
        pipeline = await compatible[0];
        await compatible[1];
      } catch (fourSampleError: unknown) {
        if (disposed) {
          throw fourSampleError instanceof Error
            ? fourSampleError
            : new Error('4x pipeline creation failed after disposal.', {
                cause: fourSampleError,
              });
        }
        sampleCount = 1;
        fellBackFrom4x = true;
        const compatible = [createPipeline(1), createPipeline(1)] as const;
        pipeline = await compatible[0];
        await compatible[1];
      }
      if (disposed || buffer === undefined) {
        throw new Error('Foundation scene creation completed after disposal.');
      }
      scene = new NativeFoundationScene(
        device,
        pipeline,
        buffer,
        format as GPUTextureFormat,
        sampleCount,
        source,
      );
      source.creationSettled();
      return Object.freeze({ scene, fellBackFrom4x });
    })().catch((error: unknown) => {
      source.creationSettled();
      source.detach();
      releaseBuffer();
      throw asError(error, 'Foundation scene creation failed.');
    });
  } catch (error: unknown) {
    source.creationSettled();
    source.detach();
    releaseBuffer();
    result = Promise.reject(asError(error, 'Foundation scene creation failed.'));
  }

  return Object.freeze({ result, dispose });
}
