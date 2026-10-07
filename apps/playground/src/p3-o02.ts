import { P3_O02_SHADERS, type P3O02ShaderName } from './p3-o02-shaders.js';

/**
 * Test-only P3.1o O02 A5 coverage rule page (docs/plans/p3-o02-a5-coverage-contract.md). It owns
 * its own adapter and device, never uses the renderer, and only reads back observed coverage and
 * per-sample draw counts.
 */

export type P3O02InitResult = Readonly<{
  status: 'READY' | 'CAPABILITY_UNAVAILABLE' | 'DEVICE_ERROR' | 'RUNNER_ERROR';
  reason: string | null;
  adapter: Readonly<Record<string, string | boolean | null>> | null;
  limits: Readonly<Record<string, number>> | null;
  shaderSha256: Readonly<Record<P3O02ShaderName, string>> | null;
}>;

export type P3O02DrawRange = Readonly<{ first: number; count: number }>;

export type P3O02RenderRequest = Readonly<{
  variant: Readonly<{ rowIndex: number; dpr: number }>;
  width: number;
  height: number;
  crop: Readonly<{ x: number; y: number; w: number; h: number }>;
  origin: readonly [number, number];
  soupBase64: string;
  featuresBase64: string;
  regionDraw: P3O02DrawRange;
  exteriorDraw: P3O02DrawRange;
}>;

export type P3O02Crop = Readonly<{
  pass: 'main' | 'count';
  sampleCount: 1 | 4;
  format: 'rgba8unorm' | 'rgba16float';
  channels: 'R' | 'RGBA';
  rleBase64: string;
  sha256: string;
}>;

export type P3O02RenderResult = Readonly<{
  status: 'RENDERED' | 'DEVICE_ERROR' | 'DEVICE_LOST' | 'ABORTED';
  reason: string | null;
  uploadSha256: Readonly<{ soup: string; features: string; uniform: string }> | null;
  crops: readonly P3O02Crop[];
}>;

export type P3O02Snapshot = Readonly<{
  state: 'IDLE' | 'READY' | 'BUSY' | 'FAILED' | 'DISPOSED';
  texturesCreated: number;
  texturesDestroyed: number;
  buffersCreated: number;
  buffersDestroyed: number;
  deviceDestroyed: boolean;
  lostReason: string | null;
}>;

export interface P3O02PageApi {
  init(): Promise<P3O02InitResult>;
  render(request: P3O02RenderRequest): Promise<P3O02RenderResult>;
  snapshot(): P3O02Snapshot;
  dispose(): Promise<void>;
}

const SHADER_NAMES = ['main', 'count', 'readout'] as const satisfies readonly P3O02ShaderName[];
const VERTEX_STRIDE = 32;
const FEATURE_MINIMUM_BYTES = 64;
const SOFTWARE_MARKERS = ['swiftshader', 'basic render', 'llvmpipe'] as const;
const ERROR_FILTERS = ['validation', 'out-of-memory', 'internal'] as const;
const TEXTURE_COPY_SOURCE = 0x01;
const TEXTURE_BINDING = 0x04;
const TEXTURE_RENDER_ATTACHMENT = 0x10;
const BUFFER_MAP_READ = 0x01;
const BUFFER_COPY_DESTINATION = 0x08;
const BUFFER_VERTEX = 0x20;
const BUFFER_UNIFORM = 0x40;
const BUFFER_STORAGE = 0x80;
const SHADER_STAGE_FRAGMENT = 0x02;
const MAP_MODE_READ = 0x01;

let state: P3O02Snapshot['state'] = 'IDLE';
let device: GPUDevice | undefined;
let uniform: GPUBuffer | undefined;
let mainLayout: GPUBindGroupLayout | undefined;
let readoutLayout: GPUBindGroupLayout | undefined;
const pipelines = new Map<string, GPURenderPipeline>();
let texturesCreated = 0;
let texturesDestroyed = 0;
let buffersCreated = 0;
let buffersDestroyed = 0;
let deviceDestroyed = false;
let disposed = false;
let lostReason: string | null = null;

const hex = (buffer: ArrayBuffer) =>
  Array.from(new Uint8Array(buffer), (byte) => byte.toString(16).padStart(2, '0')).join('');
const sha256 = async (bytes: Uint8Array<ArrayBuffer>) =>
  hex(await crypto.subtle.digest('SHA-256', bytes));

function decodeBase64(text: string): Uint8Array<ArrayBuffer> {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let start = 0; start < bytes.length; start += 0x2000)
    binary += String.fromCharCode(...bytes.subarray(start, start + 0x2000));
  return btoa(binary);
}

/** Row-major (value, count) pairs as a little-endian Uint32Array. */
function runLength(samples: Uint16Array | Uint8Array): Uint8Array {
  const pairs: number[] = [];
  for (let index = 0; index < samples.length;) {
    const value = samples[index]!;
    let end = index + 1;
    while (end < samples.length && samples[end] === value) end += 1;
    pairs.push(value, end - index);
    index = end;
  }
  const words = new Uint32Array(pairs);
  const bytes = new Uint8Array(words.length * 4);
  const view = new DataView(bytes.buffer);
  words.forEach((word, index) => view.setUint32(index * 4, word, true));
  return bytes;
}

function pushScopes(target: GPUDevice) {
  for (const filter of ERROR_FILTERS) target.pushErrorScope(filter);
}

async function popScopes(target: GPUDevice): Promise<string | null> {
  let failure: string | null = null;
  for (let index = ERROR_FILTERS.length - 1; index >= 0; index -= 1) {
    const error = await target.popErrorScope().catch((reason: unknown) => String(reason));
    if (error !== null && failure === null)
      failure = `${ERROR_FILTERS[index]}:${typeof error === 'string' ? error : error.message}`;
  }
  return failure;
}

const VERTEX_LAYOUT: GPUVertexBufferLayout = {
  arrayStride: VERTEX_STRIDE,
  attributes: [
    { shaderLocation: 0, offset: 0, format: 'float32x2' },
    { shaderLocation: 1, offset: 8, format: 'uint32x3' },
  ],
};

async function init(): Promise<P3O02InitResult> {
  if (state !== 'IDLE') throw new Error(`invalid-state:${state}`);
  const unavailable = (reason: string, adapter: P3O02InitResult['adapter'] = null) => {
    state = 'FAILED';
    return {
      status: 'CAPABILITY_UNAVAILABLE' as const,
      reason,
      adapter,
      limits: null,
      shaderSha256: null,
    };
  };
  if (!globalThis.isSecureContext) return unavailable('insecure-context');
  const gpu = (navigator as Navigator & { gpu?: GPU }).gpu;
  if (gpu === undefined) return unavailable('webgpu-unavailable');
  let adapter: GPUAdapter | null;
  try {
    adapter = await gpu.requestAdapter();
  } catch {
    adapter = null;
  }
  if (adapter === null) return unavailable('no-adapter');
  const info = adapter.info as GPUAdapterInfo & { isFallbackAdapter?: boolean };
  const legacyFallback = (adapter as GPUAdapter & { isFallbackAdapter?: boolean })
    .isFallbackAdapter;
  const adapterRecord = {
    vendor: info.vendor,
    architecture: info.architecture,
    device: info.device,
    description: info.description,
    isFallbackAdapter: info.isFallbackAdapter ?? null,
    legacyIsFallbackAdapter: legacyFallback ?? null,
  };
  if (info.isFallbackAdapter === true || legacyFallback === true)
    return unavailable('fallback', adapterRecord);
  if (info.isFallbackAdapter === undefined && legacyFallback === undefined)
    return unavailable('fallback-unknown', adapterRecord);
  const identity = `${info.vendor} ${info.architecture} ${info.description}`.toLowerCase();
  if (SOFTWARE_MARKERS.some((marker) => identity.includes(marker)))
    return unavailable('software', adapterRecord);
  try {
    device = await adapter.requestDevice();
  } catch {
    return unavailable('request-device', adapterRecord);
  }
  const target = device;
  void target.lost.then((lost) => {
    lostReason = lost.reason;
    if (!disposed) state = 'FAILED';
  });
  const limits = {
    maxTextureDimension2D: target.limits.maxTextureDimension2D,
    maxColorAttachmentBytesPerSample: target.limits.maxColorAttachmentBytesPerSample,
    maxBufferSize: target.limits.maxBufferSize,
    maxStorageBufferBindingSize: target.limits.maxStorageBufferBindingSize,
    maxInterStageShaderVariables: target.limits.maxInterStageShaderVariables,
  };
  const shaderSha256 = {} as Record<P3O02ShaderName, string>;
  const modules = {} as Record<P3O02ShaderName, GPUShaderModule>;
  pushScopes(target);
  try {
    uniform = target.createBuffer({ size: 16, usage: BUFFER_UNIFORM | BUFFER_COPY_DESTINATION });
    buffersCreated += 1;
    for (const name of SHADER_NAMES) {
      const code = P3_O02_SHADERS[name];
      shaderSha256[name] = await sha256(new TextEncoder().encode(code));
      const module = target.createShaderModule({ code });
      const compilation = await module.getCompilationInfo();
      if (compilation.messages.some((message) => message.type === 'error')) {
        await popScopes(target);
        state = 'FAILED';
        return {
          status: 'RUNNER_ERROR',
          reason: `contract-shader:${name}:${compilation.messages.map((m) => m.message).join('|')}`,
          adapter: adapterRecord,
          limits,
          shaderSha256,
        };
      }
      modules[name] = module;
    }
    mainLayout = target.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: SHADER_STAGE_FRAGMENT, buffer: { type: 'uniform' } },
        { binding: 1, visibility: SHADER_STAGE_FRAGMENT, buffer: { type: 'read-only-storage' } },
      ],
    });
    readoutLayout = target.createBindGroupLayout({
      entries: [
        {
          binding: 0,
          visibility: SHADER_STAGE_FRAGMENT,
          texture: { sampleType: 'unfilterable-float', multisampled: true },
        },
      ],
    });
    const mainPipelineLayout = target.createPipelineLayout({ bindGroupLayouts: [mainLayout] });
    const countPipelineLayout = target.createPipelineLayout({ bindGroupLayouts: [] });
    const premultiplied = {
      operation: 'add',
      srcFactor: 'one',
      dstFactor: 'one-minus-src-alpha',
    } as const;
    const additive = { operation: 'add', srcFactor: 'one', dstFactor: 'one' } as const;
    for (const sampleCount of [1, 4] as const) {
      pipelines.set(
        `main/${sampleCount}`,
        await target.createRenderPipelineAsync({
          layout: mainPipelineLayout,
          vertex: { module: modules.main, entryPoint: 'vertexMain', buffers: [VERTEX_LAYOUT] },
          fragment: {
            module: modules.main,
            entryPoint: 'fragmentMain',
            targets: [
              { format: 'rgba8unorm', blend: { color: premultiplied, alpha: premultiplied } },
            ],
          },
          primitive: { topology: 'triangle-list' },
          multisample: { count: sampleCount },
        }),
      );
      pipelines.set(
        `count/${sampleCount}`,
        await target.createRenderPipelineAsync({
          layout: countPipelineLayout,
          vertex: { module: modules.count, entryPoint: 'vertexMain', buffers: [VERTEX_LAYOUT] },
          fragment: {
            module: modules.count,
            entryPoint: 'fragmentMain',
            targets: [{ format: 'rgba16float', blend: { color: additive, alpha: additive } }],
          },
          primitive: { topology: 'triangle-list' },
          multisample: { count: sampleCount },
        }),
      );
    }
    pipelines.set(
      'readout',
      await target.createRenderPipelineAsync({
        layout: target.createPipelineLayout({ bindGroupLayouts: [readoutLayout] }),
        vertex: { module: modules.readout, entryPoint: 'vertexMain' },
        fragment: {
          module: modules.readout,
          entryPoint: 'fragmentMain',
          targets: [{ format: 'rgba16float' }],
        },
        primitive: { topology: 'triangle-list' },
      }),
    );
  } catch (reason) {
    await popScopes(target);
    return unavailable(`pipeline:${String(reason)}`, adapterRecord);
  }
  const scopeError = await popScopes(target);
  if (scopeError !== null) {
    state = 'FAILED';
    return {
      status: 'DEVICE_ERROR',
      reason: `setup:${scopeError}`,
      adapter: adapterRecord,
      limits,
      shaderSha256,
    };
  }
  state = 'READY';
  return { status: 'READY', reason: null, adapter: adapterRecord, limits, shaderSha256 };
}

function createBuffer(target: GPUDevice, size: number, usage: number): GPUBuffer {
  const buffer = target.createBuffer({ size, usage });
  buffersCreated += 1;
  return buffer;
}

function createTexture(
  target: GPUDevice,
  request: P3O02RenderRequest,
  format: GPUTextureFormat,
  sampleCount: 1 | 4,
  usage: number,
): GPUTexture {
  const texture = target.createTexture({
    size: { width: request.width, height: request.height },
    format,
    sampleCount,
    usage,
  });
  texturesCreated += 1;
  return texture;
}

function destroyBuffer(buffer: GPUBuffer | null | undefined) {
  if (buffer === null || buffer === undefined) return;
  buffer.destroy();
  buffersDestroyed += 1;
}

function destroyTexture(texture: GPUTexture | null | undefined) {
  if (texture === null || texture === undefined) return;
  texture.destroy();
  texturesDestroyed += 1;
}

type Resources = Readonly<{ soup: GPUBuffer; mainGroup: GPUBindGroup }>;

function drawMesh(pass: GPURenderPassEncoder, request: P3O02RenderRequest, soup: GPUBuffer) {
  pass.setVertexBuffer(0, soup);
  for (const range of [request.regionDraw, request.exteriorDraw])
    if (range.count > 0) pass.draw(range.count, 1, range.first);
}

/** Copies the crop of a 1x texture and extracts R (or RGBA) as row-major samples. */
async function readCrop(
  target: GPUDevice,
  encoder: GPUCommandEncoder,
  texture: GPUTexture,
  request: P3O02RenderRequest,
  format: 'rgba8unorm' | 'rgba16float',
  channels: 'R' | 'RGBA',
): Promise<{ rleBase64: string; sha256: string }> {
  const bytesPerPixel = format === 'rgba8unorm' ? 4 : 8;
  const bytesPerRow = Math.ceil((request.crop.w * bytesPerPixel) / 256) * 256;
  const staging = createBuffer(
    target,
    bytesPerRow * request.crop.h,
    BUFFER_MAP_READ | BUFFER_COPY_DESTINATION,
  );
  try {
    encoder.copyTextureToBuffer(
      { texture, origin: { x: request.crop.x, y: request.crop.y } },
      { buffer: staging, bytesPerRow, rowsPerImage: request.crop.h },
      { width: request.crop.w, height: request.crop.h },
    );
    target.queue.submit([encoder.finish()]);
    await staging.mapAsync(MAP_MODE_READ);
    const mapped = new DataView(staging.getMappedRange().slice(0));
    staging.unmap();
    const perPixel = channels === 'R' ? 1 : 4;
    const count = request.crop.w * request.crop.h * perPixel;
    const wide = format === 'rgba16float';
    const samples = wide ? new Uint16Array(count) : new Uint8Array(count);
    const raw = new Uint8Array(count * (wide ? 2 : 1));
    for (let row = 0; row < request.crop.h; row += 1)
      for (let column = 0; column < request.crop.w; column += 1)
        for (let channel = 0; channel < perPixel; channel += 1) {
          const index = (row * request.crop.w + column) * perPixel + channel;
          const offset = row * bytesPerRow + column * bytesPerPixel + channel * (wide ? 2 : 1);
          if (wide) {
            const value = mapped.getUint16(offset, true);
            samples[index] = value;
            raw[index * 2] = value & 0xff;
            raw[index * 2 + 1] = value >> 8;
          } else {
            const value = mapped.getUint8(offset);
            samples[index] = value;
            raw[index] = value;
          }
        }
    return { rleBase64: encodeBase64(runLength(samples)), sha256: await sha256(raw) };
  } finally {
    destroyBuffer(staging);
  }
}

async function renderMain(
  target: GPUDevice,
  request: P3O02RenderRequest,
  resources: Resources,
  sampleCount: 1 | 4,
): Promise<P3O02Crop> {
  const color = createTexture(
    target,
    request,
    'rgba8unorm',
    sampleCount,
    TEXTURE_RENDER_ATTACHMENT | (sampleCount === 1 ? TEXTURE_COPY_SOURCE : 0),
  );
  const resolve =
    sampleCount === 4
      ? createTexture(
          target,
          request,
          'rgba8unorm',
          1,
          TEXTURE_RENDER_ATTACHMENT | TEXTURE_COPY_SOURCE,
        )
      : null;
  try {
    const encoder = target.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: color.createView(),
          ...(resolve === null ? {} : { resolveTarget: resolve.createView() }),
          clearValue: { r: 0, g: 0, b: 0, a: 0 },
          loadOp: 'clear',
          storeOp: 'store',
        },
      ],
    });
    pass.setPipeline(pipelines.get(`main/${sampleCount}`)!);
    pass.setBindGroup(0, resources.mainGroup);
    drawMesh(pass, request, resources.soup);
    pass.end();
    const crop = await readCrop(target, encoder, resolve ?? color, request, 'rgba8unorm', 'R');
    return { pass: 'main', sampleCount, format: 'rgba8unorm', channels: 'R', ...crop };
  } finally {
    destroyTexture(color);
    destroyTexture(resolve);
  }
}

async function renderCount(
  target: GPUDevice,
  request: P3O02RenderRequest,
  resources: Resources,
  sampleCount: 1 | 4,
): Promise<P3O02Crop> {
  const counts = createTexture(
    target,
    request,
    'rgba16float',
    sampleCount,
    TEXTURE_RENDER_ATTACHMENT | (sampleCount === 1 ? TEXTURE_COPY_SOURCE : TEXTURE_BINDING),
  );
  const readout =
    sampleCount === 4
      ? createTexture(
          target,
          request,
          'rgba16float',
          1,
          TEXTURE_RENDER_ATTACHMENT | TEXTURE_COPY_SOURCE,
        )
      : null;
  try {
    const encoder = target.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: counts.createView(),
          clearValue: { r: 0, g: 0, b: 0, a: 0 },
          loadOp: 'clear',
          storeOp: 'store',
        },
      ],
    });
    pass.setPipeline(pipelines.get(`count/${sampleCount}`)!);
    drawMesh(pass, request, resources.soup);
    pass.end();
    if (readout !== null) {
      const group = target.createBindGroup({
        layout: readoutLayout!,
        entries: [{ binding: 0, resource: counts.createView() }],
      });
      const second = encoder.beginRenderPass({
        colorAttachments: [
          {
            view: readout.createView(),
            clearValue: { r: 0, g: 0, b: 0, a: 0 },
            loadOp: 'clear',
            storeOp: 'store',
          },
        ],
      });
      second.setPipeline(pipelines.get('readout')!);
      second.setBindGroup(0, group);
      second.draw(3);
      second.end();
    }
    const channels = sampleCount === 1 ? 'R' : 'RGBA';
    const crop = await readCrop(
      target,
      encoder,
      readout ?? counts,
      request,
      'rgba16float',
      channels,
    );
    return { pass: 'count', sampleCount, format: 'rgba16float', channels, ...crop };
  } finally {
    destroyTexture(counts);
    destroyTexture(readout);
  }
}

let inflight: Promise<P3O02RenderResult> | null = null;

async function renderOnce(request: P3O02RenderRequest): Promise<P3O02RenderResult> {
  const target = device!;
  let soup: GPUBuffer | null = null;
  let featureBuffer: GPUBuffer | null = null;
  const crops: P3O02Crop[] = [];
  const soupBytes = decodeBase64(request.soupBase64);
  const featureBytes = decodeBase64(request.featuresBase64);
  const originBytes = new Uint8Array(
    new Float32Array([request.origin[0], request.origin[1], 0, 0]).buffer,
  );
  let uploadSha256: P3O02RenderResult['uploadSha256'] = null;
  pushScopes(target);
  try {
    uploadSha256 = {
      soup: await sha256(soupBytes),
      features: await sha256(featureBytes),
      uniform: await sha256(originBytes),
    };
    if (soupBytes.byteLength === 0 || soupBytes.byteLength % (VERTEX_STRIDE * 3) !== 0)
      throw new Error('soup-length');
    if (featureBytes.byteLength % 64 !== 0) throw new Error('features-length');
    const vertexCount = soupBytes.byteLength / VERTEX_STRIDE;
    const { regionDraw, exteriorDraw } = request;
    for (const range of [regionDraw, exteriorDraw])
      if (
        range.first < 0 ||
        range.count < 0 ||
        range.first % 3 !== 0 ||
        range.count % 3 !== 0 ||
        range.first + range.count > vertexCount
      )
        throw new Error('draw-range');
    if (regionDraw.first + regionDraw.count > exteriorDraw.first && exteriorDraw.count > 0)
      throw new Error('draw-range-overlap');
    soup = createBuffer(target, soupBytes.byteLength, BUFFER_VERTEX | BUFFER_COPY_DESTINATION);
    target.queue.writeBuffer(soup, 0, soupBytes);
    featureBuffer = createBuffer(
      target,
      Math.max(featureBytes.byteLength, FEATURE_MINIMUM_BYTES),
      BUFFER_STORAGE | BUFFER_COPY_DESTINATION,
    );
    if (featureBytes.byteLength > 0) target.queue.writeBuffer(featureBuffer, 0, featureBytes);
    target.queue.writeBuffer(uniform!, 0, originBytes);
    const mainGroup = target.createBindGroup({
      layout: mainLayout!,
      entries: [
        { binding: 0, resource: { buffer: uniform! } },
        { binding: 1, resource: { buffer: featureBuffer } },
      ],
    });
    const resources = { soup, mainGroup };
    crops.push(await renderMain(target, request, resources, 1));
    crops.push(await renderMain(target, request, resources, 4));
    crops.push(await renderCount(target, request, resources, 1));
    crops.push(await renderCount(target, request, resources, 4));
  } catch (reason) {
    await popScopes(target).catch(() => null);
    destroyBuffer(soup);
    destroyBuffer(featureBuffer);
    if (disposed) return { status: 'ABORTED', reason: 'disposed', uploadSha256, crops: [] };
    state = 'FAILED';
    return lostReason !== null
      ? { status: 'DEVICE_LOST', reason: lostReason, uploadSha256, crops: [] }
      : { status: 'DEVICE_ERROR', reason: String(reason), uploadSha256, crops: [] };
  }
  const scopeError = await popScopes(target);
  destroyBuffer(soup);
  destroyBuffer(featureBuffer);
  if (disposed) return { status: 'ABORTED', reason: 'disposed', uploadSha256, crops: [] };
  if (scopeError !== null) {
    state = 'FAILED';
    return {
      status: 'DEVICE_ERROR',
      reason: `${request.variant.rowIndex}@${request.variant.dpr}:${scopeError}`,
      uploadSha256,
      crops: [],
    };
  }
  state = 'READY';
  return { status: 'RENDERED', reason: null, uploadSha256, crops };
}

async function render(request: P3O02RenderRequest): Promise<P3O02RenderResult> {
  if (disposed) throw new Error('disposed');
  if (state === 'BUSY') throw new Error('busy');
  if (state !== 'READY' || device === undefined) throw new Error(`invalid-state:${state}`);
  state = 'BUSY';
  inflight = renderOnce(request);
  try {
    return await inflight;
  } finally {
    inflight = null;
  }
}

async function dispose(): Promise<void> {
  if (disposed) return;
  disposed = true;
  state = 'DISPOSED';
  if (device !== undefined) {
    device.destroy();
    deviceDestroyed = true;
  }
  await inflight?.catch(() => null);
  if (uniform !== undefined) {
    uniform.destroy();
    buffersDestroyed += 1;
  }
}

function snapshot(): P3O02Snapshot {
  return {
    state,
    texturesCreated,
    texturesDestroyed,
    buffersCreated,
    buffersDestroyed,
    deviceDestroyed,
    lostReason,
  };
}

const api: P3O02PageApi = Object.freeze({ init, render, snapshot, dispose });
Object.assign(window, { __vectorStudioP3O02: api });
