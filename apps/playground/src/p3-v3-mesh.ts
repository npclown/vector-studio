import type {
  FillMesh,
  FillMeshBatchResult,
  FillMeshPort,
  FillMeshRequest,
  RenderCamera,
  RendererDiagnostic,
  RenderSceneSnapshot,
  StrokeMeshBatchResult,
  StrokeMeshPort,
  StrokeMeshRequest,
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

// B2 stroke contract, ST-A10 (unit ST-U6): with `?stroke=1` the fixture also injects a static
// test-double stroke-mesh port. Its one mesh is the stroke region of F01 at width 2 with butt
// caps and miter joins (limit 4, so every 90 degree corner keeps its miter): [-1, 11]^2 minus
// (1, 9)^2. Any other stroke request answers invalid-path. Still no WASM and no real port.
const jointMode = parameters.get('joint') === '1';
const strokeMode = parameters.get('stroke') === '1' || jointMode;
const STROKE_RING: HandMesh = {
  positions: [-1, -1, 11, -1, 11, 11, -1, 11, 1, 1, 9, 1, 9, 9, 1, 9],
  indices: RING.indices,
  boundaryEdges: RING.boundaryEdges,
};

// ST-U7 addendum, unit ST-U7d: with `?joint=1` the page is the joint fixture page. The test
// registers further hand-made meshes in Node (setStaticMeshes), keyed by path points and the
// fill rule or the stroke values, so both static doubles stay test doubles with no WASM. A
// seeded defect (`?defect=ST7-D1|ST7-D2|ST7-D8|ST7-D10`) is injected only here: the first three
// rewrite the joint factor in the shader text handed to createShaderModule, ST7-D8 swaps each
// joint fill draw with the stroke draw after it in the submitted packet. Without the parameter
// the production shader, pipelines and packet path are unmodified.
type MeshTable = Readonly<{
  fill: readonly (readonly [key: string, mesh: HandMesh])[];
  stroke: readonly (readonly [key: string, mesh: HandMesh])[];
}>;
const staticFill = new Map<string, HandMesh>();
const staticStroke = new Map<string, HandMesh>();
const seededDefect = jointMode ? parameters.get('defect') : null;
const JOINT_FACTOR = 'let factor = opacity * (1.0 - strokeAlpha) / (1.0 - opacity * strokeAlpha);';
const DEFECT_FACTORS: Readonly<Record<string, string>> = {
  'ST7-D1': 'let factor = opacity;',
  'ST7-D2': 'let factor = opacity * (1.0 - strokeAlpha);',
  'ST7-D10':
    'let factor = (1.0 - opacity) * (1.0 - strokeAlpha) / (1.0 - (1.0 - opacity) * strokeAlpha);',
};

/** The static doubles' table key of a stroke request or fill request. */
function fillKey(points: string, fillRule: string): string {
  return `${points}|${fillRule}`;
}
function strokeKey(request: StrokeMeshRequest): string {
  return [
    Array.from(request.points).join(','),
    request.width,
    request.cap,
    request.join,
    request.miterLimit,
  ].join('|');
}

/** Static stroke test double: F01, width 2, butt, miter 4 gives STROKE_RING. */
class StaticStrokeMeshPort implements StrokeMeshPort {
  readonly portVersion = 0 as const;
  readonly operationId = 'test/p3-st-u6-static-stroke-double';
  calls = 0;
  requests = 0;

  buildStrokeMeshes(requests: readonly StrokeMeshRequest[]): StrokeMeshBatchResult {
    this.calls += 1;
    this.requests += requests.length;
    return {
      status: 'ok',
      results: requests.map((request) => {
        const echo = { requestId: request.requestId, toleranceExponent: request.toleranceExponent };
        const points = Array.from(request.points).join(',');
        const registered = staticStroke.get(strokeKey(request));
        if (registered !== undefined)
          return { ...echo, status: 'ok' as const, mesh: owned(registered) };
        const known =
          points === F01_POINTS &&
          request.width === 2 &&
          request.cap === 'butt' &&
          request.join === 'miter' &&
          request.miterLimit === 4;
        return known
          ? { ...echo, status: 'ok' as const, mesh: owned(STROKE_RING) }
          : { ...echo, status: 'failed' as const, code: 'invalid-path' as const };
      }),
    };
  }
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
        const registered = staticFill.get(fillKey(points, request.fillRule));
        if (registered !== undefined) return { ...echo, status: 'ok', mesh: owned(registered) };
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
    jointDraws: number;
    meshWrites: readonly Readonly<{ resource: string; offset: number; bytes: number }>[];
    notices: number;
  }>;
  portCalls: number;
  strokePortCalls: number;
  overlayBuilds: number;
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
const strokePort = new StaticStrokeMeshPort();

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
            if (key === 'createShaderModule' && seededDefect !== null) {
              return (descriptor: GPUShaderModuleDescriptor) => {
                const factor = DEFECT_FACTORS[seededDefect];
                if (factor === undefined || !descriptor.code.includes(JOINT_FACTOR))
                  return target.createShaderModule(descriptor);
                return target.createShaderModule({
                  ...descriptor,
                  code: descriptor.code.replace(JOINT_FACTOR, factor),
                });
              };
            }
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
                        return (original: PrimitivePacket) => {
                          const packet = seededDefect === 'ST7-D8' ? swapJoint(original) : original;
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

/** ST7-D8 (seeded): each joint fill draw moves after the stroke draw that follows it. */
function swapJoint(packet: PrimitivePacket): PrimitivePacket {
  const mesh = packet.mesh;
  if (mesh === undefined) return packet;
  const draws = [...mesh.draws];
  for (let index = 0; index + 1 < draws.length; index += 1) {
    if (draws[index]!.composite === 'joint-fill') {
      [draws[index], draws[index + 1]] = [draws[index + 1]!, draws[index]!];
      index += 1;
    }
  }
  return { ...packet, mesh: { ...mesh, draws } };
}

const backend = new WebGpuBackend({ platform });
const service = new PrimitiveRendererService(backend, {
  fillMesh: port,
  ...(strokeMode ? { strokeMesh: strokePort } : {}),
});
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
        jointDraws: mesh?.draws.filter((draw) => draw.composite === 'joint-fill').length ?? 0,
        meshWrites:
          mesh?.writes.map((write) => ({
            resource: write.resourceId,
            offset: write.byteOffset,
            bytes: write.bytes.byteLength,
          })) ?? [],
        notices: mesh?.notices.length ?? 0,
      },
      portCalls: port.calls,
      strokePortCalls: strokePort.calls,
      overlayBuilds: service.getOverlayBuildCountForTesting(),
    };
  } finally {
    buffer.destroy();
  }
}

const api = {
  ready,
  /** ST-U7d joint mode only: registers static double meshes built by the test in Node. */
  setStaticMeshes(table: MeshTable) {
    if (!jointMode) throw new Error('Static meshes need ?joint=1.');
    for (const [key, mesh] of table.fill) staticFill.set(key, mesh);
    for (const [key, mesh] of table.stroke) staticStroke.set(key, mesh);
  },
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
      overlayBuilds: service.getOverlayBuildCountForTesting(),
      port: { calls: port.calls, requests: port.requests, operationId: port.operationId },
      strokePort: strokeMode
        ? {
            calls: strokePort.calls,
            requests: strokePort.requests,
            operationId: strokePort.operationId,
          }
        : null,
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
