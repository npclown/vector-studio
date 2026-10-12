import type {
  FillMesh,
  FillMeshBatchResult,
  FillMeshPort,
  FillMeshRequest,
  RenderCamera,
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

// P3 V3 contract, section l, V3-A14: the headed functional smoke fixture of unit V3c. It is a
// test fixture page, not a host: it injects a static test-double fill-mesh port with hand-made
// F01/F02 meshes and no WASM, so no playground host gets a real port before V4 (V3-A18).
// Functional evidence only: precision is UNVERIFIED against the 0.25 physical-pixel target and
// no Q4 coverage threshold is claimed. Staging copies are outside renderer accounting.

const canvas = document.querySelector<HTMLCanvasElement>('#p3-v3-surface')!;
const parameters = new URLSearchParams(location.search);
const sampleCount = parameters.get('samples') === '1' ? 1 : 4;

type HandMesh = Readonly<{ positions: number[]; indices: number[]; boundaryEdges: number[] }>;
const SQUARE: HandMesh = {
  positions: [0, 0, 10, 0, 10, 10, 0, 10],
  indices: [0, 1, 2, 0, 2, 3],
  boundaryEdges: [0, 1, 1, 2, 2, 3, 3, 0],
};
// F02 evenodd: [0,10]^2 minus [3,7]^2.
const RING: HandMesh = {
  positions: [0, 0, 10, 0, 10, 10, 0, 10, 3, 3, 7, 3, 7, 7, 3, 7],
  indices: [0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7],
  boundaryEdges: [0, 1, 1, 2, 2, 3, 3, 0, 5, 4, 6, 5, 7, 6, 4, 7],
};
const F01_POINTS = '0,0,10,0,10,10,0,10';
const F02_POINTS = '0,0,10,0,10,10,0,10,3,3,7,3,7,7,3,7';

function owned(mesh: HandMesh): FillMesh {
  const xs = mesh.positions.filter((_, index) => index % 2 === 0);
  const ys = mesh.positions.filter((_, index) => index % 2 === 1);
  return {
    positions: Float64Array.from(mesh.positions),
    indices: Uint32Array.from(mesh.indices),
    boundaryEdges: Uint32Array.from(mesh.boundaryEdges),
    bounds: {
      minX: Math.min(...xs),
      minY: Math.min(...ys),
      maxX: Math.max(...xs),
      maxY: Math.max(...ys),
    },
  };
}

/** Static test double: F01 and F02 nonzero fill the square, F02 evenodd the ring. */
class StaticFillMeshPort implements FillMeshPort {
  readonly portVersion = 0 as const;
  readonly operationId = 'test/p3-v3c-static-double';
  calls = 0;
  requests = 0;

  buildFillMeshes(requests: readonly FillMeshRequest[]): FillMeshBatchResult {
    this.calls += 1;
    this.requests += requests.length;
    return {
      status: 'ok',
      results: requests.map((request) => {
        const echo = { requestId: request.requestId, toleranceExponent: request.toleranceExponent };
        const points = Array.from(request.points).join(',');
        if (points === F01_POINTS) return { ...echo, status: 'ok', mesh: owned(SQUARE) };
        if (points === F02_POINTS) {
          return {
            ...echo,
            status: 'ok',
            mesh: owned(request.fillRule === 'evenodd' ? RING : SQUARE),
          };
        }
        return { ...echo, status: 'failed', code: 'invalid-path' };
      }),
    };
  }
}

interface CapturedFrame {
  width: number;
  height: number;
  rgbaBase64: string;
  png: string;
  packet: Readonly<{
    generation: number;
    analyticDraws: number;
    meshDraws: number;
    meshTriangles: number;
    meshWrites: readonly Readonly<{ resource: string; offset: number; bytes: number }>[];
    notices: number;
  }>;
  portCalls: number;
}

let device: GPUDevice | undefined;
let nativeContext: GPUCanvasContext | undefined;
let nextRevision = 1;
let expectedDestroyedGeneration: number | undefined;
let capture:
  | {
      minimumGeneration: number;
      resolve: (value: CapturedFrame) => void;
      reject: (reason: unknown) => void;
    }
  | undefined;
const diagnostics: RendererDiagnostic[] = [];
const port = new StaticFillMeshPort();

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
        const devicePort = await adapter.requestDevice();
        device = (devicePort as WebGpuDevicePort & { native: GPUDevice }).native;
        const actualDevice = device;
        // Only the 1x fallback (an explicit test-only rejection of 4x pipelines, as the P1
        // fixture does), an opaque black clear and COPY_SRC usage are injected; the production
        // shaders, pipelines and packet path are unmodified.
        const instrumented = new Proxy(actualDevice, {
          get(target, key) {
            if (key === 'createRenderPipelineAsync') {
              return (descriptor: GPURenderPipelineDescriptor) => {
                if (sampleCount === 1 && descriptor.multisample?.count === 4) {
                  return Promise.reject(new Error('P3 V3c fixture requests the 1x fallback.'));
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
                              : { ...attachment, clearValue: { r: 0, g: 0, b: 0, a: 1 } },
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
        const wrapped = new Proxy(devicePort, {
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
                    scene: new Proxy(scene, {
                      get(inner, member) {
                        if (member !== 'submitPrimitivePacket') return boundMember(inner, member);
                        return (packet: PrimitivePacket) => {
                          const result = inner.submitPrimitivePacket(packet);
                          const pending = capture;
                          if (
                            result.status === 'submitted' &&
                            pending !== undefined &&
                            packet.generation >= pending.minimumGeneration
                          ) {
                            capture = undefined;
                            // Queue the copy before the canvas texture expires this frame.
                            void copyFrame(actualDevice, nativeContext!, packet).then(
                              pending.resolve,
                              pending.reject,
                            );
                          }
                          return result;
                        };
                      },
                    }),
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
const service = new PrimitiveRendererService(backend, { fillMesh: port });
backend.attachPrimitiveFrameSource(service);
backend.subscribeDiagnostics((event) => {
  diagnostics.push(event);
  if (
    expectedDestroyedGeneration !== undefined &&
    event.code === 'device-loss.detected' &&
    event.generation === expectedDestroyedGeneration
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

function captureNext(minimumGeneration = 0): Promise<CapturedFrame> {
  if (capture !== undefined) throw new Error('A capture is already pending.');
  return new Promise((resolve, reject) => {
    capture = { minimumGeneration, resolve, reject };
  });
}

async function copyFrame(
  gpu: GPUDevice,
  context: GPUCanvasContext,
  packet: PrimitivePacket,
): Promise<CapturedFrame> {
  const { width, height } = packet.frame;
  const rowBytes = Math.ceil((width * 4) / 256) * 256;
  const buffer = gpu.createBuffer({ size: rowBytes * height, usage: 0x08 | 0x01 });
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
    // The clear is opaque, so every pixel is opaque and the PNG needs no unpremultiplication.
    const image = new ImageData(width, height);
    image.data.set(rgba);
    const imageCanvas = document.createElement('canvas');
    imageCanvas.width = width;
    imageCanvas.height = height;
    imageCanvas.getContext('2d')!.putImageData(image, 0, 0);
    const chunks: string[] = [];
    for (let offset = 0; offset < rgba.length; offset += 8192)
      chunks.push(String.fromCharCode(...rgba.subarray(offset, offset + 8192)));
    const mesh = packet.mesh;
    return {
      width,
      height,
      rgbaBase64: btoa(chunks.join('')),
      png: imageCanvas.toDataURL('image/png'),
      packet: {
        generation: packet.generation,
        analyticDraws: packet.draws.length,
        meshDraws: mesh?.draws.length ?? 0,
        meshTriangles: mesh?.draws.reduce((sum, draw) => sum + draw.triangleCount, 0) ?? 0,
        meshWrites:
          mesh?.writes.map((write) => ({
            resource: write.resourceId,
            offset: write.byteOffset,
            bytes: write.bytes.byteLength,
          })) ?? [],
        notices: mesh?.notices.length ?? 0,
      },
      portCalls: port.calls,
    };
  } finally {
    buffer.destroy();
  }
}

const api = {
  ready,
  async render(snapshot: RenderSceneSnapshot, camera: RenderCamera, dpr: number) {
    await ready;
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
  /** Destroys the device and captures the first frame of the recovered generation. */
  async recover() {
    if (expectedDestroyedGeneration !== undefined) throw new Error('Recovery already pending.');
    const generation = backend.getStatistics().generation;
    const pending = captureNext(generation + 1);
    expectedDestroyedGeneration = generation;
    try {
      backend.destroyDeviceForTesting();
      return await pending;
    } finally {
      expectedDestroyedGeneration = undefined;
      capture = undefined;
    }
  },
  snapshot() {
    return {
      statistics: backend.getStatistics(),
      diagnostics,
      pathMesh: service.getPathMeshStatistics(),
      port: { calls: port.calls, requests: port.requests, operationId: port.operationId },
    };
  },
  dispose() {
    service.dispose();
    backend.dispose();
    return backend.getStatistics();
  },
};

Object.assign(window, { __vectorStudioP3V3Mesh: api });
export type P3V3MeshFixtureApi = typeof api;
