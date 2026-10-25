// D9 E3 unit E3-U4: the GPU model-check page of docs/plans/d9-e3-b4-precision-contract.md
// section 7.1 (executable form in section 16). A test-only measurement page, not a host: the spec
// hands it the mesh shader's WGSL source and, per draw, the packed lanes and stored offsets that
// Node took from the product path. The page appends two readback entry points to that source, so
// the mapping it evaluates is the shader's own toPhysical and meshPositionNdc, and returns raw
// u32 words: the NDC vec4f of meshPositionNdc from the vertex stage (twice, from two separate
// draws) and toPhysical from the fragment stage. It draws one point per stored vertex into
// rgba32uint targets. For a draw that the GPU clips (E3-U5, E3-Q11 (a)) it also rasterizes the
// mesh triangles at meshPositionNdc into an r32uint target of the frame's size and returns the
// pixel-centre coverage of the strip along the viewport edge. Node does the comparison
// (readback.ts).

export type E3A04ReadbackDraw = Readonly<{
  id: string;
  frame: Readonly<{
    originMinusCamera: readonly [number, number];
    zoom: number;
    dpr: number;
    width: number;
    height: number;
  }>;
  linear: readonly [number, number, number, number];
  anchor: readonly [number, number];
  offsets: readonly number[];
  /** Clipped draws only: the triangle indices, for the strip coverage readback. */
  indices?: readonly number[];
}>;

export type E3A04ReadbackResult = Readonly<{
  id: string;
  ndc: number[];
  feature: number[];
  meshSha256: string;
  /** Clipped draws only: strip pixel-centre coverage, one bit each, packed in u32. */
  coverage?: number[];
}>;

export type E3A04ReadbackApi = Readonly<{
  ready: Promise<
    Readonly<{ supported: boolean; reason: string | null; adapter: Record<string, unknown> }>
  >;
  run(
    shader: string,
    draws: readonly E3A04ReadbackDraw[],
  ): Promise<Readonly<{ shaderSha256: string; results: E3A04ReadbackResult[] }>>;
}>;

declare global {
  interface Window {
    __vectorStudioE3A04Readback: E3A04ReadbackApi;
  }
}

const SOFTWARE_MARKERS = ['swiftshader', 'basic render', 'llvmpipe'] as const;
const TEXTURE_COPY_SOURCE = 0x01;
const TEXTURE_RENDER_ATTACHMENT = 0x10;
const BUFFER_MAP_READ = 0x01;
const BUFFER_COPY_DESTINATION = 0x08;
const BUFFER_UNIFORM = 0x40;
const BUFFER_STORAGE = 0x80;
const MAP_READ = 0x01;
/** Readback texture width in texels: 256 rgba32uint texels make a 4,096-byte row. */
const TEXTURE_WIDTH = 256;
const BUFFER_INDEX = 0x10;
/** Width of the strip along each viewport edge whose pixel centres are read (readback.ts). */
const CLIP_STRIP = 4;

/**
 * Appended to the mesh shader. The vertex entry point calls meshPositionNdc, the helper of both
 * mesh vertex entry points, and carries its result as flat u32 bits; the point itself is placed
 * at the readback slot's texel. The fragment entry point calls toPhysical, as the mesh fragment
 * stage does for features.
 */
export const E3_A04_READBACK_ENTRY_POINTS = /* wgsl */ `
struct E3ReadbackParams {
  slotBase: u32,
  textureWidth: u32,
  textureHeight: u32,
  padding: u32,
};

@group(1) @binding(0) var<uniform> e3Readback: E3ReadbackParams;

struct E3ReadbackVarying {
  @builtin(position) position: vec4f,
  @location(0) @interpolate(flat) ndc: vec4u,
  @location(1) @interpolate(flat) local: u32,
};

struct E3ReadbackTargets {
  @location(0) ndc: vec4u,
  @location(1) feature: vec4u,
};

@vertex
fn e3ReadbackVertex(@builtin(vertex_index) vertexIndex: u32) -> E3ReadbackVarying {
  let instance = instances[0];
  let ndc = meshPositionNdc(instance.vertexBase + vertexIndex, instance);
  let slot = e3Readback.slotBase + vertexIndex;
  let x = f32(slot % e3Readback.textureWidth) + 0.5;
  let y = f32(slot / e3Readback.textureWidth) + 0.5;
  var output: E3ReadbackVarying;
  output.position = vec4f(
    x * 2.0 / f32(e3Readback.textureWidth) - 1.0,
    1.0 - y * 2.0 / f32(e3Readback.textureHeight),
    0.0,
    1.0,
  );
  output.ndc = bitcast<vec4u>(ndc);
  output.local = vertexIndex;
  return output;
}

@vertex
fn e3ClipVertex(@builtin(vertex_index) vertexIndex: u32) -> @builtin(position) vec4f {
  let instance = instances[0];
  return meshPositionNdc(instance.vertexBase + vertexIndex, instance);
}

@fragment
fn e3ClipFragment() -> @location(0) vec4u {
  return vec4u(1u, 0u, 0u, 0u);
}

@fragment
fn e3ReadbackFragment(input: E3ReadbackVarying) -> E3ReadbackTargets {
  let instance = instances[0];
  let physical = toPhysical(positions[instance.vertexBase + input.local], instance);
  var output: E3ReadbackTargets;
  output.ndc = input.ndc;
  output.feature = vec4u(bitcast<vec2u>(physical), input.local, 1u);
  return output;
}
`;

async function sha256Hex(bytes: BufferSource): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('');
}

let device: GPUDevice | null = null;

const ready = (async () => {
  const adapterRecord: Record<string, unknown> = {};
  const unavailable = (reason: string) => ({ supported: false, reason, adapter: adapterRecord });
  if (!globalThis.isSecureContext) return unavailable('insecure-context');
  const gpu = (navigator as Navigator & { gpu?: GPU }).gpu;
  if (gpu === undefined) return unavailable('webgpu-unavailable');
  const adapter = await gpu.requestAdapter().catch(() => null);
  if (adapter === null) return unavailable('no-adapter');
  const info = adapter.info as GPUAdapterInfo & { isFallbackAdapter?: boolean };
  Object.assign(adapterRecord, {
    vendor: info.vendor,
    architecture: info.architecture,
    device: info.device,
    description: info.description,
    isFallbackAdapter: info.isFallbackAdapter ?? null,
    userAgent: navigator.userAgent,
    devicePixelRatio: globalThis.devicePixelRatio,
  });
  const identity = `${info.vendor} ${info.architecture} ${info.description}`.toLowerCase();
  const software =
    info.isFallbackAdapter === true || SOFTWARE_MARKERS.some((marker) => identity.includes(marker));
  adapterRecord.software = software;
  // ?allowSoftware=1 is a diagnostic dry run only: a software adapter is never A04 evidence, and
  // combineGpuChecks rejects any record whose adapter is software.
  if (software && new URLSearchParams(location.search).get('allowSoftware') !== '1')
    return unavailable('software');
  try {
    device = await adapter.requestDevice();
  } catch {
    return unavailable('request-device');
  }
  return { supported: true, reason: null, adapter: adapterRecord };
})();

async function readTexture(target: GPUDevice, texture: GPUTexture, rows: number) {
  const bytesPerRow = TEXTURE_WIDTH * 16;
  const buffer = target.createBuffer({
    size: bytesPerRow * rows,
    usage: BUFFER_MAP_READ | BUFFER_COPY_DESTINATION,
  });
  const encoder = target.createCommandEncoder();
  encoder.copyTextureToBuffer(
    { texture },
    { buffer, bytesPerRow, rowsPerImage: rows },
    { width: TEXTURE_WIDTH, height: rows },
  );
  target.queue.submit([encoder.finish()]);
  await buffer.mapAsync(MAP_READ);
  const words = new Uint32Array(buffer.getMappedRange().slice(0));
  buffer.unmap();
  buffer.destroy();
  return words;
}

/**
 * Rasterizes the mesh at meshPositionNdc into an r32uint target of the frame's size, one sample
 * at each pixel centre, and returns the coverage of the edge strip in canonical order (rows top to
 * bottom, each left to right), one bit per pixel.
 */
async function clipCoverage(
  target: GPUDevice,
  pipeline: GPURenderPipeline,
  draw: E3A04ReadbackDraw,
  buffers: Readonly<{ positions: GPUBuffer; instances: GPUBuffer; frame: GPUBuffer }>,
): Promise<number[]> {
  const indices = Uint32Array.from(draw.indices ?? []);
  const { width, height } = draw.frame;
  const index = target.createBuffer({
    size: Math.max(16, indices.byteLength),
    usage: BUFFER_INDEX | BUFFER_COPY_DESTINATION,
  });
  target.queue.writeBuffer(index, 0, indices);
  const texture = target.createTexture({
    size: { width, height },
    format: 'r32uint',
    usage: TEXTURE_RENDER_ATTACHMENT | TEXTURE_COPY_SOURCE,
  });
  const group = target.createBindGroup({
    layout: pipeline.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer: buffers.positions } },
      { binding: 4, resource: { buffer: buffers.instances } },
      { binding: 5, resource: { buffer: buffers.frame } },
    ],
  });
  const bytesPerRow = Math.ceil((width * 4) / 256) * 256;
  const readback = target.createBuffer({
    size: bytesPerRow * height,
    usage: BUFFER_MAP_READ | BUFFER_COPY_DESTINATION,
  });
  const encoder = target.createCommandEncoder();
  const pass = encoder.beginRenderPass({
    colorAttachments: [
      {
        view: texture.createView(),
        clearValue: { r: 0, g: 0, b: 0, a: 0 },
        loadOp: 'clear' as const,
        storeOp: 'store' as const,
      },
    ],
  });
  pass.setPipeline(pipeline);
  pass.setBindGroup(0, group);
  pass.setIndexBuffer(index, 'uint32');
  pass.drawIndexed(indices.length);
  pass.end();
  encoder.copyTextureToBuffer(
    { texture },
    { buffer: readback, bytesPerRow, rowsPerImage: height },
    { width, height },
  );
  target.queue.submit([encoder.finish()]);
  await readback.mapAsync(MAP_READ);
  const words = new Uint32Array(readback.getMappedRange().slice(0));
  readback.unmap();
  readback.destroy();
  index.destroy();
  texture.destroy();
  const stride = bytesPerRow / 4;
  const bits: number[] = [];
  let k = 0;
  for (let y = 0; y < height; y += 1)
    for (let x = 0; x < width; x += 1) {
      if (x >= CLIP_STRIP && x < width - CLIP_STRIP && y >= CLIP_STRIP && y < height - CLIP_STRIP)
        continue;
      if ((k & 31) === 0) bits.push(0);
      if (words[y * stride + x] !== 0) bits[k >>> 5] = (bits[k >>> 5]! | (1 << (k & 31))) >>> 0;
      k += 1;
    }
  return bits;
}

async function runDraw(
  target: GPUDevice,
  pipeline: GPURenderPipeline,
  clipPipeline: GPURenderPipeline,
  draw: E3A04ReadbackDraw,
): Promise<E3A04ReadbackResult> {
  const points = draw.offsets.length / 2;
  const offsets = Float32Array.from(draw.offsets);
  const meshSha256 = await sha256Hex(offsets);
  // Two passes over the points (slots 0 to n − 1 and n to 2n − 1), rows a power of two.
  let rows = 1;
  while (rows * TEXTURE_WIDTH < 2 * points) rows *= 2;
  const positions = target.createBuffer({
    size: Math.max(16, offsets.byteLength),
    usage: BUFFER_STORAGE | BUFFER_COPY_DESTINATION,
  });
  target.queue.writeBuffer(positions, 0, offsets);
  // MeshInstance: linear, anchor, orientation, opacity, fill, vertexBase, listBase, featureBase,
  // strokeLink (64 bytes).
  const instanceBytes = new ArrayBuffer(64);
  new Float32Array(instanceBytes, 0, 8).set([...draw.linear, ...draw.anchor, 1, 1]);
  const instances = target.createBuffer({
    size: 64,
    usage: BUFFER_STORAGE | BUFFER_COPY_DESTINATION,
  });
  target.queue.writeBuffer(instances, 0, instanceBytes);
  // MeshFrame: originMinusCamera, zoom, devicePixelRatio, physicalSize, padding (32 bytes).
  const frame = target.createBuffer({ size: 32, usage: BUFFER_UNIFORM | BUFFER_COPY_DESTINATION });
  target.queue.writeBuffer(
    frame,
    0,
    Float32Array.from([
      ...draw.frame.originMinusCamera,
      draw.frame.zoom,
      draw.frame.dpr,
      draw.frame.width,
      draw.frame.height,
      0,
      0,
    ]),
  );
  const params = [0, points].map((slotBase) => {
    const buffer = target.createBuffer({
      size: 16,
      usage: BUFFER_UNIFORM | BUFFER_COPY_DESTINATION,
    });
    target.queue.writeBuffer(buffer, 0, Uint32Array.from([slotBase, TEXTURE_WIDTH, rows, 0]));
    return buffer;
  });
  const meshGroup = target.createBindGroup({
    layout: pipeline.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer: positions } },
      { binding: 4, resource: { buffer: instances } },
      { binding: 5, resource: { buffer: frame } },
    ],
  });
  const textures = [0, 1].map(() =>
    target.createTexture({
      size: { width: TEXTURE_WIDTH, height: rows },
      format: 'rgba32uint',
      usage: TEXTURE_RENDER_ATTACHMENT | TEXTURE_COPY_SOURCE,
    }),
  );
  const encoder = target.createCommandEncoder();
  const pass = encoder.beginRenderPass({
    colorAttachments: textures.map((texture) => ({
      view: texture.createView(),
      clearValue: { r: 0, g: 0, b: 0, a: 0 },
      loadOp: 'clear' as const,
      storeOp: 'store' as const,
    })),
  });
  pass.setPipeline(pipeline);
  pass.setBindGroup(0, meshGroup);
  // Two separate draws: each vertex is mapped by two invocations.
  for (const buffer of params) {
    pass.setBindGroup(
      1,
      target.createBindGroup({
        layout: pipeline.getBindGroupLayout(1),
        entries: [{ binding: 0, resource: { buffer } }],
      }),
    );
    pass.draw(points);
  }
  pass.end();
  target.queue.submit([encoder.finish()]);
  const [ndcWords, featureWords] = await Promise.all(
    textures.map((texture) => readTexture(target, texture, rows)),
  );
  const coverage =
    draw.indices === undefined
      ? undefined
      : await clipCoverage(target, clipPipeline, draw, { positions, instances, frame });
  for (const buffer of [positions, instances, frame, ...params]) buffer.destroy();
  for (const texture of textures) texture.destroy();
  return {
    id: draw.id,
    ndc: Array.from(ndcWords!.subarray(0, 8 * points)),
    feature: Array.from(featureWords!.subarray(0, 4 * points)),
    meshSha256,
    ...(coverage === undefined ? {} : { coverage }),
  };
}

async function run(shader: string, draws: readonly E3A04ReadbackDraw[]) {
  const status = await ready;
  if (!status.supported || device === null) throw new Error(`WebGPU unavailable: ${status.reason}`);
  const target = device;
  const shaderSha256 = await sha256Hex(new TextEncoder().encode(shader));
  target.pushErrorScope('validation');
  const module = target.createShaderModule({ code: shader + E3_A04_READBACK_ENTRY_POINTS });
  const pipeline = await target.createRenderPipelineAsync({
    layout: 'auto',
    vertex: { module, entryPoint: 'e3ReadbackVertex' },
    fragment: {
      module,
      entryPoint: 'e3ReadbackFragment',
      targets: [{ format: 'rgba32uint' }, { format: 'rgba32uint' }],
    },
    primitive: { topology: 'point-list' },
  });
  const clipPipeline = await target.createRenderPipelineAsync({
    layout: 'auto',
    vertex: { module, entryPoint: 'e3ClipVertex' },
    fragment: { module, entryPoint: 'e3ClipFragment', targets: [{ format: 'r32uint' }] },
    primitive: { topology: 'triangle-list', cullMode: 'none' },
  });
  const results: E3A04ReadbackResult[] = [];
  for (const draw of draws) results.push(await runDraw(target, pipeline, clipPipeline, draw));
  const error = await target.popErrorScope();
  if (error !== null) throw new Error(`WebGPU validation: ${error.message}`);
  return { shaderSha256, results };
}

window.__vectorStudioE3A04Readback = { ready, run };
