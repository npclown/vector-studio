import { P3_COVERAGE_SHADERS, type P3CoverageCandidate } from './p3-coverage-shaders.js';

/**
 * Test-only P3.1o O01 coverage page (docs/plans/p3-o01-coverage-experiment-contract.md). It owns
 * its own adapter and device, never uses the renderer, and only reads back observed coverage.
 */

export type P3CoverageInitResult = Readonly<{
  status: 'READY' | 'CAPABILITY_UNAVAILABLE' | 'DEVICE_ERROR' | 'RUNNER_ERROR';
  reason: string | null;
  adapter: Readonly<Record<string, string | boolean | null>> | null;
  limits: Readonly<Record<string, number>> | null;
  shaderSha256: Readonly<Record<P3CoverageCandidate, string>> | null;
}>;

export type P3CoverageRenderRequest = Readonly<{
  rowIndex: number;
  width: number;
  height: number;
  crop: Readonly<{ x: number; y: number; w: number; h: number }>;
  origin: readonly [number, number];
  soupBase64: string;
  fringeBase64: string;
}>;

export type P3CoverageCrop = Readonly<{
  candidate: P3CoverageCandidate;
  sampleCount: 1 | 4;
  pass: 'main' | 'diagMax' | 'diagAdd';
  format: 'rgba8unorm' | 'rgba16float';
  rleBase64: string;
  sha256: string;
}>;

export type P3CoverageRenderResult = Readonly<{
  status: 'RENDERED' | 'DEVICE_ERROR' | 'DEVICE_LOST' | 'ABORTED';
  reason: string | null;
  uploadSha256: Readonly<{ soup: string; fringe: string; uniform: string }> | null;
  crops: readonly P3CoverageCrop[];
}>;

export type P3CoverageSnapshot = Readonly<{
  state: 'IDLE' | 'READY' | 'BUSY' | 'FAILED' | 'DISPOSED';
  texturesCreated: number;
  texturesDestroyed: number;
  buffersCreated: number;
  buffersDestroyed: number;
  deviceDestroyed: boolean;
  lostReason: string | null;
}>;

export interface P3CoveragePageApi {
  init(): Promise<P3CoverageInitResult>;
  render(request: P3CoverageRenderRequest): Promise<P3CoverageRenderResult>;
  snapshot(): P3CoverageSnapshot;
  dispose(): Promise<void>;
}

type Variant = Readonly<{
  pass: P3CoverageCrop['pass'];
  format: P3CoverageCrop['format'];
  sampleCount: 1 | 4;
  operation: GPUBlendOperation;
}>;

const CANDIDATES = ['A1', 'A2', 'A5'] as const satisfies readonly P3CoverageCandidate[];
const VARIANTS: readonly Variant[] = [
  { pass: 'main', format: 'rgba8unorm', sampleCount: 1, operation: 'max' },
  { pass: 'main', format: 'rgba8unorm', sampleCount: 4, operation: 'max' },
  { pass: 'diagMax', format: 'rgba16float', sampleCount: 1, operation: 'max' },
  { pass: 'diagAdd', format: 'rgba16float', sampleCount: 1, operation: 'add' },
];
const VERTEX_STRIDE = 64;
const SOFTWARE_MARKERS = ['swiftshader', 'basic render', 'llvmpipe'] as const;
const ERROR_FILTERS = ['validation', 'out-of-memory', 'internal'] as const;
const TEXTURE_RENDER_ATTACHMENT = 0x10;
const TEXTURE_COPY_SOURCE = 0x01;
const BUFFER_VERTEX = 0x20;
const BUFFER_UNIFORM = 0x40;
const BUFFER_COPY_DESTINATION = 0x08;
const BUFFER_MAP_READ = 0x01;
const SHADER_STAGE_FRAGMENT = 0x02;
const MAP_MODE_READ = 0x01;

let state: P3CoverageSnapshot['state'] = 'IDLE';
let device: GPUDevice | undefined;
let uniform: GPUBuffer | undefined;
let bindGroup: GPUBindGroup | undefined;
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

const pipelineKey = (candidate: string, kind: string, variant: Variant) =>
  `${candidate}/${kind}/${variant.pass}/${variant.sampleCount}`;

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

async function init(): Promise<P3CoverageInitResult> {
  if (state !== 'IDLE') throw new Error(`invalid-state:${state}`);
  const unavailable = (reason: string, adapter: P3CoverageInitResult['adapter'] = null) => {
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
    maxInterStageShaderVariables: target.limits.maxInterStageShaderVariables,
  };
  const shaderSha256 = {} as Record<P3CoverageCandidate, string>;
  pushScopes(target);
  try {
    uniform = target.createBuffer({ size: 16, usage: BUFFER_UNIFORM | BUFFER_COPY_DESTINATION });
    buffersCreated += 1;
    const layout = target.createBindGroupLayout({
      entries: [{ binding: 0, visibility: SHADER_STAGE_FRAGMENT, buffer: { type: 'uniform' } }],
    });
    bindGroup = target.createBindGroup({
      layout,
      entries: [{ binding: 0, resource: { buffer: uniform } }],
    });
    const pipelineLayout = target.createPipelineLayout({ bindGroupLayouts: [layout] });
    for (const candidate of CANDIDATES) {
      const code = P3_COVERAGE_SHADERS[candidate];
      shaderSha256[candidate] = await sha256(new TextEncoder().encode(code));
      const module = target.createShaderModule({ code });
      const compilation = await module.getCompilationInfo();
      if (compilation.messages.some((message) => message.type === 'error')) {
        await popScopes(target);
        state = 'FAILED';
        return {
          status: 'RUNNER_ERROR',
          reason: `contract-shader:${candidate}`,
          adapter: adapterRecord,
          limits,
          shaderSha256,
        };
      }
      for (const kind of ['interior', 'fringe'] as const)
        for (const variant of VARIANTS) {
          const component = {
            operation: variant.operation,
            srcFactor: 'one',
            dstFactor: 'one',
          } as const;
          const pipeline = await target.createRenderPipelineAsync({
            layout: pipelineLayout,
            vertex: {
              module,
              entryPoint: 'vertexMain',
              buffers: [
                {
                  arrayStride: VERTEX_STRIDE,
                  attributes: [0, 1, 2, 3].map((location) => ({
                    shaderLocation: location,
                    offset: location * 16,
                    format: 'float32x4' as const,
                  })),
                },
              ],
            },
            fragment: {
              module,
              entryPoint: kind === 'interior' ? 'interiorMain' : 'fringeMain',
              targets: [{ format: variant.format, blend: { color: component, alpha: component } }],
            },
            primitive: { topology: 'triangle-list' },
            multisample: { count: variant.sampleCount },
          });
          pipelines.set(pipelineKey(candidate, kind, variant), pipeline);
        }
    }
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

function vertexBuffer(target: GPUDevice, bytes: Uint8Array<ArrayBuffer>): GPUBuffer | null {
  if (bytes.byteLength === 0) return null;
  if (bytes.byteLength % (VERTEX_STRIDE * 3) !== 0) throw new Error('soup-length');
  const buffer = target.createBuffer({
    size: bytes.byteLength,
    usage: BUFFER_VERTEX | BUFFER_COPY_DESTINATION,
  });
  buffersCreated += 1;
  target.queue.writeBuffer(buffer, 0, bytes);
  return buffer;
}

function destroyBuffer(buffer: GPUBuffer | null) {
  if (buffer === null) return;
  buffer.destroy();
  buffersDestroyed += 1;
}

function destroyTexture(texture: GPUTexture | null) {
  if (texture === null) return;
  texture.destroy();
  texturesDestroyed += 1;
}

async function renderVariant(
  target: GPUDevice,
  request: P3CoverageRenderRequest,
  candidate: P3CoverageCandidate,
  variant: Variant,
  soup: GPUBuffer | null,
  fringe: GPUBuffer | null,
): Promise<P3CoverageCrop> {
  const usage = TEXTURE_RENDER_ATTACHMENT | (variant.sampleCount === 1 ? TEXTURE_COPY_SOURCE : 0);
  const size = { width: request.width, height: request.height };
  const color = target.createTexture({
    size,
    format: variant.format,
    sampleCount: variant.sampleCount,
    usage,
  });
  texturesCreated += 1;
  const resolve =
    variant.sampleCount === 4
      ? target.createTexture({
          size,
          format: variant.format,
          usage: TEXTURE_RENDER_ATTACHMENT | TEXTURE_COPY_SOURCE,
        })
      : null;
  if (resolve !== null) texturesCreated += 1;
  const bytesPerPixel = variant.format === 'rgba8unorm' ? 4 : 8;
  const bytesPerRow = Math.ceil((request.crop.w * bytesPerPixel) / 256) * 256;
  const staging = target.createBuffer({
    size: bytesPerRow * request.crop.h,
    usage: BUFFER_MAP_READ | BUFFER_COPY_DESTINATION,
  });
  buffersCreated += 1;
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
    pass.setBindGroup(0, bindGroup!);
    if (soup !== null) {
      pass.setPipeline(pipelines.get(pipelineKey(candidate, 'interior', variant))!);
      pass.setVertexBuffer(0, soup);
      pass.draw(soup.size / VERTEX_STRIDE);
    }
    if (fringe !== null && candidate !== 'A2') {
      pass.setPipeline(pipelines.get(pipelineKey(candidate, 'fringe', variant))!);
      pass.setVertexBuffer(0, fringe);
      pass.draw(fringe.size / VERTEX_STRIDE);
    }
    pass.end();
    encoder.copyTextureToBuffer(
      { texture: resolve ?? color, origin: { x: request.crop.x, y: request.crop.y } },
      { buffer: staging, bytesPerRow, rowsPerImage: request.crop.h },
      { width: request.crop.w, height: request.crop.h },
    );
    target.queue.submit([encoder.finish()]);
    await staging.mapAsync(MAP_MODE_READ);
    const mapped = new DataView(staging.getMappedRange().slice(0));
    staging.unmap();
    const count = request.crop.w * request.crop.h;
    const wide = variant.format === 'rgba16float';
    const samples = wide ? new Uint16Array(count) : new Uint8Array(count);
    const raw = new Uint8Array(count * (wide ? 2 : 1));
    for (let row = 0; row < request.crop.h; row += 1)
      for (let column = 0; column < request.crop.w; column += 1) {
        const index = row * request.crop.w + column;
        const offset = row * bytesPerRow + column * bytesPerPixel;
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
    return {
      candidate,
      sampleCount: variant.sampleCount,
      pass: variant.pass,
      format: variant.format,
      rleBase64: encodeBase64(runLength(samples)),
      sha256: await sha256(raw),
    };
  } finally {
    destroyBuffer(staging);
    destroyTexture(color);
    destroyTexture(resolve);
  }
}

let inflight: Promise<P3CoverageRenderResult> | null = null;

async function renderOnce(request: P3CoverageRenderRequest): Promise<P3CoverageRenderResult> {
  const target = device!;
  let soup: GPUBuffer | null = null;
  let fringe: GPUBuffer | null = null;
  const crops: P3CoverageCrop[] = [];
  const soupBytes = decodeBase64(request.soupBase64);
  const fringeBytes = decodeBase64(request.fringeBase64);
  const originBytes = new Uint8Array(
    new Float32Array([request.origin[0], request.origin[1], 0, 0]).buffer,
  );
  let uploadSha256: P3CoverageRenderResult['uploadSha256'] = null;
  pushScopes(target);
  try {
    uploadSha256 = {
      soup: await sha256(soupBytes),
      fringe: await sha256(fringeBytes),
      uniform: await sha256(originBytes),
    };
    soup = vertexBuffer(target, soupBytes);
    fringe = vertexBuffer(target, fringeBytes);
    target.queue.writeBuffer(uniform!, 0, originBytes);
    for (const candidate of CANDIDATES)
      for (const variant of VARIANTS)
        crops.push(await renderVariant(target, request, candidate, variant, soup, fringe));
  } catch (reason) {
    await popScopes(target).catch(() => null);
    destroyBuffer(soup);
    destroyBuffer(fringe);
    if (disposed) return { status: 'ABORTED', reason: 'disposed', uploadSha256, crops: [] };
    state = 'FAILED';
    return lostReason !== null
      ? { status: 'DEVICE_LOST', reason: lostReason, uploadSha256, crops: [] }
      : { status: 'DEVICE_ERROR', reason: String(reason), uploadSha256, crops: [] };
  }
  const scopeError = await popScopes(target);
  destroyBuffer(soup);
  destroyBuffer(fringe);
  if (disposed) return { status: 'ABORTED', reason: 'disposed', uploadSha256, crops: [] };
  if (scopeError !== null) {
    state = 'FAILED';
    return {
      status: 'DEVICE_ERROR',
      reason: `${request.rowIndex}:${scopeError}`,
      uploadSha256,
      crops: [],
    };
  }
  state = 'READY';
  return { status: 'RENDERED', reason: null, uploadSha256, crops };
}

async function render(request: P3CoverageRenderRequest): Promise<P3CoverageRenderResult> {
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

function snapshot(): P3CoverageSnapshot {
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

const api: P3CoveragePageApi = Object.freeze({ init, render, snapshot, dispose });
Object.assign(window, { __vectorStudioP3Coverage: api });
