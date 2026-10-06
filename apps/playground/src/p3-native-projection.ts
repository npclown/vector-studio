import { P3_NATIVE_PROJECTION_WGSL } from './p3-native-projection-shader.js';

/**
 * Test-only P3.1l native projection fixture (contract L02/L04 in
 * docs/plans/p3-native-projection-readiness.md). It owns its own adapter and device through
 * `navigator.gpu` and never uses the renderer backend, renderer-core or the P1 probe.
 * Captured words are observations; this page never classifies them.
 */

export type P3ProjectionState = 'IDLE' | 'READY' | 'BUSY' | 'FAILED' | 'DISPOSED';

export type P3ProjectionFallbackStatus = 'FALLBACK' | 'NOT_FALLBACK' | 'UNKNOWN';

export type P3ProjectionAdapterRecord = Readonly<{
  vendor: string | null;
  architecture: string | null;
  device: string | null;
  description: string | null;
  /** `adapter.info.isFallbackAdapter` when exposed as a boolean, otherwise null. */
  infoIsFallbackAdapter: boolean | null;
  /** Legacy `adapter.isFallbackAdapter` when exposed as a boolean, otherwise null. */
  legacyIsFallbackAdapter: boolean | null;
  fallbackStatus: P3ProjectionFallbackStatus;
  /** Lowercase software marker matched in vendor, architecture or description. */
  softwareMatch: string | null;
  /** A browser-exposed backend string, or the literal `UNEXPOSED`. */
  backend: string;
}>;

export type P3ProjectionLimits = Readonly<{
  maxBindGroups: number;
  maxColorAttachments: number;
  maxColorAttachmentBytesPerSample: number;
  maxStorageBuffersPerShaderStage: number;
  /** Null when the browser does not expose this limit. */
  maxStorageBuffersInVertexStage: number | null;
  maxStorageBufferBindingSize: number;
  maxUniformBufferBindingSize: number;
  maxTextureDimension2D: number;
  maxInterStageShaderVariables: number;
}>;

export type P3ProjectionCompilationMessage = Readonly<{
  type: string;
  message: string;
  lineNum: number;
  linePos: number;
  offset: number;
  length: number;
}>;

export type P3ProjectionInitStatus =
  'READY' | 'CAPABILITY_UNAVAILABLE' | 'DEVICE_ERROR' | 'DEVICE_LOST' | 'RUNNER_ERROR';

export type P3ProjectionInitResult = Readonly<{
  status: P3ProjectionInitStatus;
  /** Null for READY; otherwise the text after `<status>:` in the L04 reason format. */
  reason: string | null;
  adapter: P3ProjectionAdapterRecord | null;
  limits: P3ProjectionLimits | null;
  /** Lowercase SHA-256 of the UTF-8 bytes of the WGSL string compiled by this page. */
  shaderSha256: string | null;
  compilationMessages: readonly P3ProjectionCompilationMessage[];
}>;

export type P3ProjectionCaptureRequest = Readonly<{
  rowIndex: number;
  captureTag: number;
  drawCount: number;
  uniformBase64: string;
  verticesBase64: string;
}>;

export type P3ProjectionCaptureResult =
  | Readonly<{
      status: 'CAPTURED';
      readbackBase64: string;
      uploadSha256: Readonly<{ uniform: string; vertices: string }>;
    }>
  | Readonly<{
      status: 'DEVICE_ERROR' | 'DEVICE_LOST' | 'ABORTED';
      reason: string;
    }>;

export type P3ProjectionSnapshot = Readonly<{
  state: P3ProjectionState;
  buffersCreated: number;
  buffersDestroyed: number;
  texturesCreated: number;
  texturesDestroyed: number;
  deviceDestroyed: boolean;
  /** Null when no readback buffer was created. */
  readbackMapState: GPUBufferMapState | null;
  lostReason: string | null;
}>;

export interface P3ProjectionPageApi {
  init(): Promise<P3ProjectionInitResult>;
  capture(request: P3ProjectionCaptureRequest): Promise<P3ProjectionCaptureResult>;
  snapshot(): P3ProjectionSnapshot;
  dispose(): Promise<void>;
}

const UNIFORM_BYTES = 64;
const VERTEX_BYTES = 4096;
const TEXTURE_SIZE = 16;
const TEXTURE_BYTES = 4096;
const READBACK_BYTES = 8192;
const BYTES_PER_ROW = 256;
const MAX_SLOTS = 256;
const SENTINEL = 4294967040;
const TEXTURE_FORMAT: GPUTextureFormat = 'rgba32uint';

const BUFFER_MAP_READ = 0x01;
const BUFFER_COPY_DESTINATION = 0x08;
const BUFFER_UNIFORM = 0x40;
const BUFFER_STORAGE = 0x80;
const TEXTURE_COPY_SOURCE = 0x01;
const TEXTURE_RENDER_ATTACHMENT = 0x10;
const SHADER_STAGE_VERTEX = 0x01;
const MAP_MODE_READ = 0x01;

const SOFTWARE_MARKERS = Object.freeze(['swiftshader', 'basic render', 'llvmpipe'] as const);
const ERROR_FILTERS = Object.freeze(['validation', 'out-of-memory', 'internal'] as const);
const LOST_WAIT_MS = 1000;

const MINIMUM_LIMITS = Object.freeze([
  ['maxBindGroups', 1],
  ['maxColorAttachments', 2],
  ['maxColorAttachmentBytesPerSample', 32],
  ['maxStorageBuffersPerShaderStage', 1],
  ['maxStorageBuffersInVertexStage', 1],
  ['maxStorageBufferBindingSize', 4096],
  ['maxUniformBufferBindingSize', 64],
  ['maxTextureDimension2D', 16],
  ['maxInterStageShaderVariables', 2],
] as const);

type TerminalResult = Readonly<{ status: 'DEVICE_ERROR' | 'DEVICE_LOST'; reason: string }>;

interface PendingCapture {
  readonly rowIndex: number;
  settled: boolean;
  resolve(result: P3ProjectionCaptureResult): void;
}

let state: P3ProjectionState = 'IDLE';
let initStarted = false;
let disposed = false;
let device: GPUDevice | undefined;
let uniformBuffer: GPUBuffer | undefined;
let vertexBuffer: GPUBuffer | undefined;
let readbackBuffer: GPUBuffer | undefined;
let xyTexture: GPUTexture | undefined;
let zwTexture: GPUTexture | undefined;
let pipeline: GPURenderPipeline | undefined;
let bindGroup: GPUBindGroup | undefined;
const destroyedBuffers = new Set<GPUBuffer>();
const destroyedTextures = new Set<GPUTexture>();
let buffersCreated = 0;
let texturesCreated = 0;
let deviceDestroyed = false;
let lostReason: string | null = null;
let lostSignal: Promise<unknown> | undefined;
let terminal: TerminalResult | undefined;
let setupErrorSeen = false;
let lastDispatchedRow: number | undefined;
let pending: PendingCapture | undefined;

interface ReadyResources {
  readonly target: GPUDevice;
  readonly uniform: GPUBuffer;
  readonly vertices: GPUBuffer;
  readonly readback: GPUBuffer;
  readonly xy: GPUTexture;
  readonly zw: GPUTexture;
  readonly pipeline: GPURenderPipeline;
  readonly bindGroup: GPUBindGroup;
}

let ready: ReadyResources | undefined;

function readString(source: unknown, key: string): string | null {
  if (source === null || typeof source !== 'object') return null;
  const value: unknown = Reflect.get(source, key);
  return typeof value === 'string' ? value : null;
}

function readBoolean(source: unknown, key: string): boolean | null {
  if (source === null || typeof source !== 'object') return null;
  const value: unknown = Reflect.get(source, key);
  return typeof value === 'boolean' ? value : null;
}

function readNumber(source: unknown, key: string): number | null {
  if (source === null || typeof source !== 'object') return null;
  const value: unknown = Reflect.get(source, key);
  return typeof value === 'number' ? value : null;
}

function hex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function sha256(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  return hex(await crypto.subtle.digest('SHA-256', bytes));
}

function decodeBase64(text: string): Uint8Array<ArrayBuffer> {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x2000;
  for (let start = 0; start < bytes.length; start += chunk) {
    binary += String.fromCharCode(...bytes.subarray(start, start + chunk));
  }
  return btoa(binary);
}

function describeAdapter(adapter: GPUAdapter): P3ProjectionAdapterRecord {
  const info: unknown = Reflect.get(adapter, 'info');
  const vendor = readString(info, 'vendor');
  const architecture = readString(info, 'architecture');
  const deviceName = readString(info, 'device');
  const description = readString(info, 'description');
  const infoIsFallbackAdapter = readBoolean(info, 'isFallbackAdapter');
  const legacyIsFallbackAdapter = readBoolean(adapter, 'isFallbackAdapter');
  const fallbackStatus: P3ProjectionFallbackStatus =
    infoIsFallbackAdapter === true || legacyIsFallbackAdapter === true
      ? 'FALLBACK'
      : infoIsFallbackAdapter === null && legacyIsFallbackAdapter === null
        ? 'UNKNOWN'
        : 'NOT_FALLBACK';
  let softwareMatch: string | null = null;
  for (const field of [vendor, architecture, description]) {
    const lowered = (field ?? '').toLowerCase();
    const marker = SOFTWARE_MARKERS.find((candidate) => lowered.includes(candidate));
    if (marker !== undefined) {
      softwareMatch = marker;
      break;
    }
  }
  return Object.freeze({
    vendor,
    architecture,
    device: deviceName,
    description,
    infoIsFallbackAdapter,
    legacyIsFallbackAdapter,
    fallbackStatus,
    softwareMatch,
    backend: readString(info, 'backend') ?? 'UNEXPOSED',
  });
}

function describeLimits(limits: GPUSupportedLimits): P3ProjectionLimits {
  const required = (key: string): number => readNumber(limits, key) ?? Number.NaN;
  return Object.freeze({
    maxBindGroups: required('maxBindGroups'),
    maxColorAttachments: required('maxColorAttachments'),
    maxColorAttachmentBytesPerSample: required('maxColorAttachmentBytesPerSample'),
    maxStorageBuffersPerShaderStage: required('maxStorageBuffersPerShaderStage'),
    maxStorageBuffersInVertexStage: readNumber(limits, 'maxStorageBuffersInVertexStage'),
    maxStorageBufferBindingSize: required('maxStorageBufferBindingSize'),
    maxUniformBufferBindingSize: required('maxUniformBufferBindingSize'),
    maxTextureDimension2D: required('maxTextureDimension2D'),
    maxInterStageShaderVariables: required('maxInterStageShaderVariables'),
  });
}

function failedLimit(limits: P3ProjectionLimits): string | undefined {
  for (const [key, minimum] of MINIMUM_LIMITS) {
    const value = limits[key];
    if (value === null && key === 'maxStorageBuffersInVertexStage') continue;
    if (value === null || !(value >= minimum)) return key;
  }
  return undefined;
}

function settlePending(result: P3ProjectionCaptureResult): void {
  const current = pending;
  if (current === undefined || current.settled) return;
  current.settled = true;
  pending = undefined;
  current.resolve(result);
}

function enterTerminal(result: TerminalResult): void {
  if (disposed) return;
  terminal ??= result;
  state = 'FAILED';
  settlePending(terminal);
}

function onUncapturedError(event: GPUUncapturedErrorEvent): void {
  console.error('[p3-native-projection] uncapturederror', event.error.message);
  if (disposed) return;
  if (!initStarted || state === 'IDLE') {
    setupErrorSeen = true;
    return;
  }
  const row = pending?.rowIndex ?? lastDispatchedRow;
  enterTerminal({ status: 'DEVICE_ERROR', reason: row === undefined ? 'setup' : String(row) });
}

function watchDevice(target: GPUDevice): void {
  target.addEventListener('uncapturederror', onUncapturedError);
  lostSignal = target.lost.then((info) => {
    lostReason = info.reason;
    if (disposed && info.reason === 'destroyed') return;
    console.error('[p3-native-projection] device lost', info.reason, info.message);
    if (state === 'IDLE') return;
    enterTerminal({ status: 'DEVICE_LOST', reason: info.reason });
  });
}

function pushScopes(target: GPUDevice): void {
  for (const filter of ERROR_FILTERS) target.pushErrorScope(filter);
}

/** Pops the three scopes in reverse push order. True when any scope captured an error. */
async function popScopes(target: GPUDevice): Promise<boolean> {
  let errorSeen = false;
  for (let index = ERROR_FILTERS.length - 1; index >= 0; index -= 1) {
    try {
      const error = await target.popErrorScope();
      if (error !== null) {
        console.error('[p3-native-projection] scope', ERROR_FILTERS[index], error.message);
        errorSeen = true;
      }
    } catch (reason) {
      console.error('[p3-native-projection] popErrorScope rejected', reason);
      errorSeen = true;
    }
  }
  return errorSeen;
}

function createBuffer(target: GPUDevice, label: string, size: number, usage: number): GPUBuffer {
  const buffer = target.createBuffer({ label, size, usage });
  buffersCreated += 1;
  return buffer;
}

function createTexture(target: GPUDevice, label: string): GPUTexture {
  const texture = target.createTexture({
    label,
    size: { width: TEXTURE_SIZE, height: TEXTURE_SIZE, depthOrArrayLayers: 1 },
    format: TEXTURE_FORMAT,
    usage: TEXTURE_RENDER_ATTACHMENT | TEXTURE_COPY_SOURCE,
  });
  texturesCreated += 1;
  return texture;
}

function releaseResources(): void {
  if (readbackBuffer !== undefined && readbackBuffer.mapState !== 'unmapped') {
    try {
      readbackBuffer.unmap();
    } catch (reason) {
      console.error('[p3-native-projection] unmap failed', reason);
    }
  }
  for (const buffer of [uniformBuffer, vertexBuffer, readbackBuffer]) {
    if (buffer === undefined || destroyedBuffers.has(buffer)) continue;
    buffer.destroy();
    destroyedBuffers.add(buffer);
  }
  for (const texture of [xyTexture, zwTexture]) {
    if (texture === undefined || destroyedTextures.has(texture)) continue;
    texture.destroy();
    destroyedTextures.add(texture);
  }
  if (device !== undefined && !deviceDestroyed) {
    device.destroy();
    deviceDestroyed = true;
  }
}

function initResult(
  status: P3ProjectionInitStatus,
  reason: string | null,
  details: Partial<Omit<P3ProjectionInitResult, 'status' | 'reason'>>,
): P3ProjectionInitResult {
  if (status !== 'READY' && !disposed) state = 'FAILED';
  return Object.freeze({
    status,
    reason,
    adapter: details.adapter ?? null,
    limits: details.limits ?? null,
    shaderSha256: details.shaderSha256 ?? null,
    compilationMessages: Object.freeze([...(details.compilationMessages ?? [])]),
  });
}

async function init(): Promise<P3ProjectionInitResult> {
  if (disposed) throw new Error('disposed');
  if (initStarted) throw new Error(`invalid-state:${state}`);
  initStarted = true;
  const code = P3_NATIVE_PROJECTION_WGSL;
  const details: {
    adapter?: P3ProjectionAdapterRecord;
    limits?: P3ProjectionLimits;
    shaderSha256?: string;
    compilationMessages?: P3ProjectionCompilationMessage[];
  } = {};
  const abortedByDispose = (): P3ProjectionInitResult => {
    releaseResources();
    return initResult('RUNNER_ERROR', 'disposed', details);
  };

  // Preflight 1: secure context with navigator.gpu.
  if (!globalThis.isSecureContext) {
    return initResult('CAPABILITY_UNAVAILABLE', 'insecure-context', details);
  }
  details.shaderSha256 = await sha256(new TextEncoder().encode(code));
  if (disposed) return abortedByDispose();
  const gpu: unknown = Reflect.get(navigator, 'gpu');
  if (gpu === undefined || gpu === null) {
    return initResult('CAPABILITY_UNAVAILABLE', 'webgpu-unavailable', details);
  }

  // Preflight 2: default adapter request.
  let adapter: GPUAdapter | null;
  try {
    adapter = await (gpu as GPU).requestAdapter();
  } catch (reason) {
    console.error('[p3-native-projection] requestAdapter rejected', reason);
    adapter = null;
  }
  if (disposed) return abortedByDispose();
  if (adapter === null) return initResult('CAPABILITY_UNAVAILABLE', 'no-adapter', details);

  // Preflight 3: fallback and software detection. Identity is always recorded first.
  const adapterRecord = describeAdapter(adapter);
  details.adapter = adapterRecord;
  if (adapterRecord.fallbackStatus === 'FALLBACK') {
    return initResult('CAPABILITY_UNAVAILABLE', 'fallback', details);
  }
  if (adapterRecord.fallbackStatus === 'UNKNOWN') {
    return initResult('CAPABILITY_UNAVAILABLE', 'fallback-unknown', details);
  }
  if (adapterRecord.softwareMatch !== null) {
    return initResult('CAPABILITY_UNAVAILABLE', 'software', details);
  }

  // Preflight 4: device with no required features or limits.
  try {
    device = await adapter.requestDevice();
  } catch (reason) {
    console.error('[p3-native-projection] requestDevice rejected', reason);
    if (disposed) return abortedByDispose();
    return initResult('CAPABILITY_UNAVAILABLE', 'request-device', details);
  }
  const target = device;
  watchDevice(target);
  if (disposed) return abortedByDispose();

  // Preflight 5: minimum device limits.
  const limits = describeLimits(target.limits);
  details.limits = limits;
  const missing = failedLimit(limits);
  if (missing !== undefined) {
    return initResult('CAPABILITY_UNAVAILABLE', `limit:${missing}`, details);
  }

  // Resources, inside validation / out-of-memory / internal scopes popped in reverse.
  pushScopes(target);
  let shaderDefect = false;
  try {
    uniformBuffer = createBuffer(
      target,
      'p3-projection-uniform',
      UNIFORM_BYTES,
      BUFFER_UNIFORM | BUFFER_COPY_DESTINATION,
    );
    vertexBuffer = createBuffer(
      target,
      'p3-projection-vertices',
      VERTEX_BYTES,
      BUFFER_STORAGE | BUFFER_COPY_DESTINATION,
    );
    xyTexture = createTexture(target, 'p3-projection-xy');
    zwTexture = createTexture(target, 'p3-projection-zw');
    readbackBuffer = createBuffer(
      target,
      'p3-projection-readback',
      READBACK_BYTES,
      BUFFER_MAP_READ | BUFFER_COPY_DESTINATION,
    );
    const module = target.createShaderModule({ label: 'p3-native-projection', code });
    const info = await module.getCompilationInfo();
    details.compilationMessages = info.messages.map((message) =>
      Object.freeze({
        type: message.type,
        message: message.message,
        lineNum: message.lineNum,
        linePos: message.linePos,
        offset: message.offset,
        length: message.length,
      }),
    );
    if (info.messages.some((message) => message.type === 'error')) {
      shaderDefect = true;
    } else {
      const bindGroupLayout = target.createBindGroupLayout({
        label: 'p3-projection-bind-group-layout',
        entries: [
          { binding: 0, visibility: SHADER_STAGE_VERTEX, buffer: { type: 'uniform' } },
          { binding: 1, visibility: SHADER_STAGE_VERTEX, buffer: { type: 'read-only-storage' } },
        ],
      });
      const pipelineLayout = target.createPipelineLayout({
        label: 'p3-projection-pipeline-layout',
        bindGroupLayouts: [bindGroupLayout],
      });
      try {
        pipeline = await target.createRenderPipelineAsync({
          label: 'p3-native-projection',
          layout: pipelineLayout,
          vertex: { module, entryPoint: 'nativeProjectionVertex', buffers: [] },
          fragment: {
            module,
            entryPoint: 'nativeProjectionFragment',
            targets: [{ format: TEXTURE_FORMAT }, { format: TEXTURE_FORMAT }],
          },
          primitive: { topology: 'point-list' },
        });
      } catch (reason) {
        console.error('[p3-native-projection] createRenderPipelineAsync rejected', reason);
        shaderDefect = true;
      }
      if (pipeline !== undefined) {
        bindGroup = target.createBindGroup({
          label: 'p3-projection-bind-group',
          layout: bindGroupLayout,
          entries: [
            { binding: 0, resource: { buffer: uniformBuffer } },
            { binding: 1, resource: { buffer: vertexBuffer } },
          ],
        });
      }
    }
  } finally {
    if (await popScopes(target)) setupErrorSeen = true;
  }
  if (disposed) return abortedByDispose();
  if (shaderDefect) return initResult('RUNNER_ERROR', 'contract-shader', details);
  if (lostReason !== null) return initResult('DEVICE_LOST', lostReason, details);
  if (
    setupErrorSeen ||
    lostReason !== null ||
    uniformBuffer === undefined ||
    vertexBuffer === undefined ||
    readbackBuffer === undefined ||
    xyTexture === undefined ||
    zwTexture === undefined ||
    pipeline === undefined ||
    bindGroup === undefined
  ) {
    return initResult('DEVICE_ERROR', 'setup', details);
  }
  ready = Object.freeze({
    target,
    uniform: uniformBuffer,
    vertices: vertexBuffer,
    readback: readbackBuffer,
    xy: xyTexture,
    zw: zwTexture,
    pipeline,
    bindGroup,
  });
  state = 'READY';
  return initResult('READY', null, details);
}

function checkedInteger(value: unknown, name: string, minimum: number, maximum: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) throw new Error(`${name}-type`);
  if (value < minimum || value > maximum) throw new Error(`${name}-range:${value}`);
  return value;
}

function capture(request: P3ProjectionCaptureRequest): Promise<P3ProjectionCaptureResult> {
  if (disposed) return Promise.reject(new Error('disposed'));
  if (state === 'BUSY') return Promise.reject(new Error('busy'));
  if (state === 'FAILED' && terminal !== undefined) return Promise.resolve(terminal);
  const resources = ready;
  if (state !== 'READY' || resources === undefined) {
    return Promise.reject(new Error(`invalid-state:${state}`));
  }
  let rowIndex: number;
  let drawCount: number;
  let uniform: Uint8Array<ArrayBuffer>;
  let vertices: Uint8Array<ArrayBuffer>;
  try {
    rowIndex = checkedInteger(request.rowIndex, 'rowIndex', 0, 0xffffffff);
    checkedInteger(request.captureTag, 'captureTag', 0, 0xffffffff);
    drawCount = checkedInteger(request.drawCount, 'drawCount', 0, MAX_SLOTS);
    // Fresh copies: later host or page mutation cannot change this submission.
    uniform = decodeBase64(request.uniformBase64);
    vertices = decodeBase64(request.verticesBase64);
    if (uniform.byteLength !== UNIFORM_BYTES) {
      throw new Error(`uniform-length:${uniform.byteLength}`);
    }
    if (vertices.byteLength !== VERTEX_BYTES) {
      throw new Error(`vertices-length:${vertices.byteLength}`);
    }
  } catch (reason) {
    return Promise.reject(reason instanceof Error ? reason : new Error(String(reason)));
  }
  state = 'BUSY';
  return new Promise<P3ProjectionCaptureResult>((resolve) => {
    const current: PendingCapture = { rowIndex, settled: false, resolve };
    pending = current;
    const deviceError: TerminalResult = { status: 'DEVICE_ERROR', reason: String(rowIndex) };
    void submit(resources, current, drawCount, uniform, vertices).then(
      (result) => {
        if (current.settled) return;
        if (result === null) {
          enterTerminal(deviceError);
          return;
        }
        state = 'READY';
        settlePending(result);
      },
      (reason: unknown) => {
        console.error('[p3-native-projection] submission threw', reason);
        enterTerminal(deviceError);
      },
    );
  });
}

/** Runs one L02 submission. Null means a device error for this row. */
async function submit(
  resources: ReadyResources,
  current: PendingCapture,
  drawCount: number,
  uniform: Uint8Array<ArrayBuffer>,
  vertices: Uint8Array<ArrayBuffer>,
): Promise<P3ProjectionCaptureResult | null> {
  const { target, uniform: uniformTarget, vertices: vertexTarget, readback, xy, zw } = resources;
  const [uniformSha256, verticesSha256] = await Promise.all([sha256(uniform), sha256(vertices)]);
  if (current.settled) return null;
  lastDispatchedRow = current.rowIndex;
  pushScopes(target);
  let mapped = false;
  let copied: Uint8Array | undefined;
  try {
    target.queue.writeBuffer(uniformTarget, 0, uniform);
    target.queue.writeBuffer(vertexTarget, 0, vertices);
    const sentinel = { r: SENTINEL, g: SENTINEL, b: SENTINEL, a: SENTINEL };
    const encoder = target.createCommandEncoder({ label: `p3-projection-row-${current.rowIndex}` });
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        { view: xy.createView(), clearValue: sentinel, loadOp: 'clear', storeOp: 'store' },
        { view: zw.createView(), clearValue: sentinel, loadOp: 'clear', storeOp: 'store' },
      ],
    });
    pass.setPipeline(resources.pipeline);
    pass.setBindGroup(0, resources.bindGroup);
    pass.draw(drawCount, 1, 0, 0);
    pass.end();
    const extent = { width: TEXTURE_SIZE, height: TEXTURE_SIZE, depthOrArrayLayers: 1 };
    encoder.copyTextureToBuffer(
      { texture: xy },
      { buffer: readback, offset: 0, bytesPerRow: BYTES_PER_ROW, rowsPerImage: TEXTURE_SIZE },
      extent,
    );
    encoder.copyTextureToBuffer(
      { texture: zw },
      {
        buffer: readback,
        offset: TEXTURE_BYTES,
        bytesPerRow: BYTES_PER_ROW,
        rowsPerImage: TEXTURE_SIZE,
      },
      extent,
    );
    target.queue.submit([encoder.finish()]);
    try {
      await readback.mapAsync(MAP_MODE_READ, 0, READBACK_BYTES);
      mapped = true;
    } catch (reason) {
      console.error('[p3-native-projection] mapAsync rejected', reason);
    }
  } finally {
    // Scopes are popped only after mapAsync settles.
    const scopeError = await popScopes(target);
    if (readback.mapState === 'mapped') {
      if (mapped && !scopeError && !current.settled) {
        copied = new Uint8Array(readback.getMappedRange(0, READBACK_BYTES).slice(0));
      }
      readback.unmap();
    }
    if (scopeError) copied = undefined;
  }
  if (copied === undefined || copied.byteLength !== READBACK_BYTES) return null;
  return Object.freeze({
    status: 'CAPTURED',
    readbackBase64: encodeBase64(copied),
    uploadSha256: Object.freeze({ uniform: uniformSha256, vertices: verticesSha256 }),
  });
}

async function dispose(): Promise<void> {
  if (disposed) return;
  disposed = true;
  state = 'DISPOSED';
  settlePending({ status: 'ABORTED', reason: 'disposed' });
  releaseResources();
  if (lostSignal !== undefined) {
    await Promise.race([
      lostSignal,
      new Promise<void>((resolve) => setTimeout(resolve, LOST_WAIT_MS)),
    ]);
  }
}

function snapshot(): P3ProjectionSnapshot {
  return Object.freeze({
    state,
    buffersCreated,
    buffersDestroyed: destroyedBuffers.size,
    texturesCreated,
    texturesDestroyed: destroyedTextures.size,
    deviceDestroyed,
    readbackMapState: readbackBuffer?.mapState ?? null,
    lostReason,
  });
}

const api: P3ProjectionPageApi = Object.freeze({ init, capture, snapshot, dispose });

Object.assign(window, { __vectorStudioP3Projection: api });
