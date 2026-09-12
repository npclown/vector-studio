import type {
  RenderCamera,
  RenderChangeSet,
  RendererDiagnostic,
  RenderSceneSnapshot,
} from '@vector-studio/contracts';
import { PrimitiveRendererService, type PrimitivePacket } from '@vector-studio/renderer-core';
import {
  createBrowserWebGpuPlatform,
  WebGpuBackend,
  type WebGpuDevicePort,
  type WebGpuPlatform,
} from '@vector-studio/renderer-webgpu';
import {
  disposePositionProbe,
  probeNativePositions,
  type NativePositionProbeResult,
} from './p1-position-probe.js';

// This entry is a functional test harness. Its staging copies and PNG conversion are
// outside renderer accounting and must never be used for performance evidence.
const canvas = document.querySelector<HTMLCanvasElement>('#p1-surface')!;
const parameters = new URLSearchParams(location.search);
const sampleCount = parameters.get('samples') === '1' ? 1 : 4;
let transparent = false;
let nextRevision = 0;
let productionShader = '';
let positionsRequested = false;
let lastPacketRevision: number | undefined;
let expectedDestroyedGeneration: number | undefined;
let device: GPUDevice | undefined;
let nativeContext: GPUCanvasContext | undefined;
let capture:
  { resolve: (value: CapturedFrame) => void; reject: (reason: unknown) => void } | undefined;
const diagnostics: RendererDiagnostic[] = [];

interface CapturedFrame {
  width: number;
  height: number;
  rgbaBase64: string;
  png: string;
  positions: readonly NativePositionProbeResult[];
  packet: {
    revision: number;
    generation: number;
    mode: string;
    count: number;
    orderSlots: number[];
    writes: { resource: string; offset: number; bytes: number }[];
  };
}

function boundMember<T extends object>(target: T, key: string | symbol): unknown {
  const value: unknown = Reflect.get(target, key);
  return typeof value === 'function' ? value.bind(target) : value;
}

const browserPlatform = createBrowserWebGpuPlatform();
const platform: WebGpuPlatform = {
  secureContext: browserPlatform.secureContext,
  apiAvailable: browserPlatform.apiAvailable,
  getPreferredCanvasFormat: () => browserPlatform.getPreferredCanvasFormat(),
  getCanvasContext(surface) {
    nativeContext = surface.getContext('webgpu') as GPUCanvasContext;
    return {
      native: nativeContext,
      configure(configuration) {
        nativeContext!.configure({
          device: device!,
          format: configuration.format as GPUTextureFormat,
          alphaMode: configuration.alphaMode,
          colorSpace: 'srgb',
          usage: 0x10 | 0x01,
        });
      },
      unconfigure() {
        nativeContext!.unconfigure();
      },
    };
  },
  async requestAdapter() {
    const adapter = await browserPlatform.requestAdapter();
    if (adapter === null) return null;
    return {
      info: adapter.info,
      async requestDevice() {
        const port = await adapter.requestDevice();
        device = (port as WebGpuDevicePort & { native: GPUDevice }).native;
        const actualDevice = device;
        // Exercise the existing 4x -> 1x fallback with a deliberate test-only
        // capability rejection. The successful pipeline/shader stay unmodified.
        const instrumented = new Proxy(actualDevice, {
          get(target, key) {
            if (key === 'createShaderModule') {
              return (descriptor: GPUShaderModuleDescriptor) => {
                productionShader = descriptor.code;
                return target.createShaderModule(descriptor);
              };
            }
            if (key === 'createRenderPipelineAsync') {
              return (descriptor: GPURenderPipelineDescriptor) => {
                if (sampleCount === 1 && descriptor.multisample?.count === 4) {
                  return Promise.reject(new Error('P1 fixture requests existing 1x fallback.'));
                }
                return target.createRenderPipelineAsync(descriptor);
              };
            }
            if (key === 'createCommandEncoder') {
              return (descriptor?: GPUCommandEncoderDescriptor) => {
                const encoder = target.createCommandEncoder(descriptor);
                return new Proxy(encoder, {
                  get(command, member) {
                    if (member === 'beginRenderPass') {
                      return (pass: GPURenderPassDescriptor) =>
                        command.beginRenderPass({
                          ...pass,
                          colorAttachments: Array.from(pass.colorAttachments, (attachment) =>
                            attachment === null
                              ? null
                              : {
                                  ...attachment,
                                  clearValue: { r: 0, g: 0, b: 0, a: transparent ? 0 : 1 },
                                },
                          ),
                        });
                    }
                    return boundMember(command, member);
                  },
                });
              };
            }
            return boundMember(target, key);
          },
        });
        const wrapped = new Proxy(port, {
          get(target, key) {
            if (key === 'native') return instrumented;
            if (key === 'createPrimitiveScene') {
              return (
                ...args: Parameters<NonNullable<WebGpuDevicePort['createPrimitiveScene']>>
              ) => {
                const creation = target.createPrimitiveScene!.apply(wrapped, args);
                return {
                  dispose: () => creation.dispose(),
                  result: creation.result.then(({ scene, fellBackFrom4x }) => ({
                    fellBackFrom4x,
                    scene: {
                      sampleCount: scene.sampleCount,
                      pipelinesCreated: scene.pipelinesCreated,
                      shaderModulesCreated: scene.shaderModulesCreated,
                      setTarget: scene.setTarget.bind(scene),
                      dispose: scene.dispose.bind(scene),
                      submitPrimitivePacket(packet: PrimitivePacket) {
                        const result = scene.submitPrimitivePacket(packet);
                        if (result.status === 'submitted') {
                          lastPacketRevision = packet.scene.revision;
                          const pending = capture;
                          if (pending !== undefined) {
                            capture = undefined;
                            // Queue the copy before the browser expires the current
                            // canvas texture at the end of this animation frame.
                            const capturedPacket: PrimitivePacket = {
                              ...packet,
                              writes: packet.writes.map((write) => ({
                                ...write,
                                bytes: write.bytes.slice(),
                              })),
                            };
                            void copyFrame(actualDevice, nativeContext!, capturedPacket).then(
                              pending.resolve,
                              pending.reject,
                            );
                          }
                        }
                        return result;
                      },
                    },
                  })),
                };
              };
            }
            return boundMember(target, key);
          },
        });
        return wrapped;
      },
    };
  },
};

const backend = new WebGpuBackend({ platform });
const service = new PrimitiveRendererService(backend);
backend.attachPrimitiveFrameSource(service);
backend.subscribeDiagnostics((event) => {
  diagnostics.push(event);
  if (
    expectedDestroyedGeneration !== undefined &&
    event.code === 'device-loss.detected' &&
    event.severity === 'error' &&
    event.generation === expectedDestroyedGeneration &&
    event.context?.reason === 'destroyed'
  ) {
    expectedDestroyedGeneration = undefined;
    return;
  }
  if (event.severity === 'error' && capture !== undefined) {
    capture.reject(new Error(JSON.stringify(event)));
    capture = undefined;
  }
});
const ready = backend.initialize({
  canvas,
  cssSize: { width: 640, height: 360 },
  devicePixelRatio: 1,
});

function captureNext(): Promise<CapturedFrame> {
  if (capture !== undefined) throw new Error('A capture is already pending.');
  return new Promise((resolve, reject) => {
    capture = { resolve, reject };
  });
}

async function copyFrame(
  gpu: GPUDevice,
  context: GPUCanvasContext,
  packet: PrimitivePacket,
): Promise<CapturedFrame> {
  const { width, height } = packet.frame;
  const rowBytes = Math.ceil((width * 4) / 256) * 256;
  const buffer = gpu.createBuffer({
    size: rowBytes * height,
    usage: 0x08 | 0x01,
  });
  try {
    const encoder = gpu.createCommandEncoder();
    encoder.copyTextureToBuffer(
      { texture: context.getCurrentTexture() },
      { buffer, bytesPerRow: rowBytes },
      { width, height },
    );
    gpu.queue.submit([encoder.finish()]);
    await buffer.mapAsync(0x01);
    const mapped = new Uint8Array(buffer.getMappedRange());
    const rgba = new Uint8Array(width * height * 4);
    for (let y = 0; y < height; y++)
      rgba.set(mapped.subarray(y * rowBytes, y * rowBytes + width * 4), y * width * 4);
    if (packet.frame.targetFormat === 'bgra8unorm') {
      for (let index = 0; index < rgba.length; index += 4) {
        const red = rgba[index]!;
        rgba[index] = rgba[index + 2]!;
        rgba[index + 2] = red;
      }
    }
    // ImageData/PNG is straight alpha. Keep raw premultiplied bytes separately for
    // numerical assertions, and explicitly unpremultiply only for PNG encoding.
    const image = new ImageData(width, height);
    for (let index = 0; index < rgba.length; index += 4) {
      const alpha = rgba[index + 3]!;
      for (let channel = 0; channel < 3; channel++)
        image.data[index + channel] =
          alpha === 0 ? 0 : Math.round((rgba[index + channel]! * 255) / alpha);
      image.data[index + 3] = alpha;
    }
    const imageCanvas = document.createElement('canvas');
    imageCanvas.width = width;
    imageCanvas.height = height;
    imageCanvas.getContext('2d')!.putImageData(image, 0, 0);
    const chunks: string[] = [];
    for (let offset = 0; offset < rgba.length; offset += 8192)
      chunks.push(String.fromCharCode(...rgba.subarray(offset, offset + 8192)));
    const positions =
      positionsRequested && packet.draws.length > 0
        ? await probeNativePositions(gpu, productionShader, packet)
        : [];
    return {
      width,
      height,
      positions,
      rgbaBase64: btoa(chunks.join('')),
      png: imageCanvas.toDataURL('image/png'),
      packet: {
        revision: packet.scene.revision,
        generation: packet.generation,
        mode: packet.mode,
        count: packet.draws.reduce((sum, draw) => sum + draw.count, 0),
        orderSlots: packet.writes
          .filter((write) => write.resourceId === 'order')
          .flatMap((write) => {
            const view = new DataView(
              write.bytes.buffer,
              write.bytes.byteOffset,
              write.bytes.byteLength,
            );
            return Array.from({ length: write.bytes.byteLength / 4 }, (_, index) =>
              view.getUint32(index * 4, true),
            );
          }),
        writes: packet.writes.map((write) => ({
          resource: write.resourceId,
          offset: write.byteOffset,
          bytes: write.bytes.length,
        })),
      },
    };
  } finally {
    buffer.destroy();
  }
}

const api = {
  ready,
  async render(
    snapshot: RenderSceneSnapshot,
    camera: RenderCamera,
    dpr: number,
    clearTransparent: boolean,
    measurePositions = false,
  ) {
    await ready;
    transparent = clearTransparent;
    positionsRequested = measurePositions;
    backend.resize({ width: 640, height: 360 }, dpr);
    const result = service.replaceSnapshot({ ...snapshot, revision: nextRevision++ });
    if (result.status !== 'applied' && result.status !== 'replayed')
      throw new Error(JSON.stringify(result));
    const cameraResult = service.setCamera(camera);
    if (cameraResult.status !== 'applied' && cameraResult.status !== 'unchanged')
      throw new Error(JSON.stringify(cameraResult));
    const pending = captureNext();
    backend.invalidate({ reason: 'scene' });
    return pending;
  },
  async edit(changes: RenderChangeSet) {
    const result = service.applyChanges(changes);
    if (result.status !== 'applied') throw new Error(JSON.stringify(result));
    return captureNext();
  },
  reject(snapshot: RenderSceneSnapshot) {
    return service.replaceSnapshot(snapshot);
  },
  async recoverWithEdit(changes: RenderChangeSet) {
    if (expectedDestroyedGeneration !== undefined) throw new Error('Recovery already pending.');
    const pending = captureNext();
    expectedDestroyedGeneration = backend.getStatistics().generation;
    try {
      backend.destroyDeviceForTesting();
      const result = service.applyChanges(changes);
      if (result.status !== 'applied') throw new Error(JSON.stringify(result));
      const recovered = await pending;
      if (expectedDestroyedGeneration !== undefined)
        throw new Error('The deliberately destroyed generation did not emit a loss event.');
      return recovered;
    } finally {
      expectedDestroyedGeneration = undefined;
      capture = undefined;
    }
  },
  async redraw() {
    const pending = captureNext();
    backend.invalidate({ reason: 'scene' });
    return pending;
  },
  snapshot() {
    return {
      statistics: backend.getStatistics(),
      diagnostics,
      current: service.getSynchronizationState(),
      packetRevision: lastPacketRevision,
    };
  },
  dispose() {
    if (device !== undefined) disposePositionProbe(device);
    service.dispose();
    backend.dispose();
    return backend.getStatistics();
  },
};

Object.assign(window, { __vectorStudioP1: api });
export type P1FixtureApi = typeof api;
