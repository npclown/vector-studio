import type { PrimitivePacket, PrimitiveResourceId } from '@vector-studio/renderer-core';

/**
 * Test-only native evidence probe. The production vertex body executes on the vertex
 * stage, but the wrapper relocates four point primitives into readback cells. Results
 * therefore evidence native vertex arithmetic, not the unmodified raster images.
 */

export type NativePositionProbeResult = Readonly<{
  x: number;
  y: number;
  localX: number;
  localY: number;
}>;

const BUFFER_COPY_DESTINATION = 0x08;
const BUFFER_MAP_READ = 0x01;
const BUFFER_STORAGE = 0x80;
const BUFFER_UNIFORM = 0x40;
const SHADER_STAGE_VERTEX = 0x01;
const TEXTURE_COPY_SOURCE = 0x01;
const TEXTURE_RENDER_ATTACHMENT = 0x10;
const MAP_READ = 0x01;
const ROW_BYTES = 256;

const RESOURCE_IDS = Object.freeze(['transforms', 'geometry', 'styles', 'order', 'frame'] as const);

const N02_INITIAL_CAPACITIES: Readonly<Record<PrimitiveResourceId, number>> = Object.freeze({
  transforms: 16 * 32,
  geometry: 16 * 48,
  styles: 16 * 48,
  order: 16 * 4,
  frame: 32,
});

const N02_RECONSTRUCT_WRITES: Readonly<Record<PrimitiveResourceId, number>> = Object.freeze({
  transforms: 32,
  geometry: 48,
  styles: 48,
  order: 4,
  frame: 32,
});

const PRODUCTION_VERTEX_HEADER = `@vertex
fn vertexMain(
  @location(0) unitPosition: vec2f,
  @builtin(instance_index) instanceIndex: u32,
) -> VertexOutput {`;

const PROBE_VERTEX_HEADER = `fn probeProductionVertex(
  unitPosition: vec2f,
  instanceIndex: u32,
) -> VertexOutput {`;

const PROBE_SHADER_SUFFIX = /* wgsl */ `

struct PositionProbeVertexOutput {
  @builtin(position) position: vec4f,
  @location(0) @interpolate(flat) originalClip: vec4f,
  @location(1) @interpolate(flat) originalLocal: vec2f,
};

struct PositionProbeFragmentOutput {
  @location(0) originalClip: vec4f,
  @location(1) originalLocal: vec4f,
};

@vertex
fn positionProbeVertex(
  @builtin(vertex_index) vertexIndex: u32,
  @builtin(instance_index) instanceIndex: u32,
) -> PositionProbeVertexOutput {
  let unitPositions = array<vec2f, 4>(
    vec2f(0.0, 0.0),
    vec2f(1.0, 0.0),
    vec2f(0.0, 1.0),
    vec2f(1.0, 1.0),
  );
  let production = probeProductionVertex(unitPositions[vertexIndex], instanceIndex);

  var output: PositionProbeVertexOutput;
  output.position = vec4f((f32(vertexIndex) + 0.5) * 0.5 - 1.0, 0.0, 0.0, 1.0);
  output.originalClip = production.position;
  output.originalLocal = production.localPosition;
  return output;
}

@fragment
fn positionProbeFragment(input: PositionProbeVertexOutput) -> PositionProbeFragmentOutput {
  var output: PositionProbeFragmentOutput;
  output.originalClip = input.originalClip;
  output.originalLocal = vec4f(input.originalLocal, 0.0, 1.0);
  return output;
}
`;

interface ProbeBindings {
  bindGroup: GPUBindGroup;
  buffers: ReadonlyMap<PrimitiveResourceId, GPUBuffer>;
}

interface DeviceProbeCache {
  bindGroupLayout: GPUBindGroupLayout;
  pipelineLayout: GPUPipelineLayout;
  pipelines: Map<string, Promise<GPURenderPipeline>>;
  bindings?: ProbeBindings;
}

const deviceCaches = new WeakMap<GPUDevice, DeviceProbeCache>();

export async function probeNativePositions(
  device: GPUDevice,
  shaderCode: string,
  packet: PrimitivePacket,
): Promise<readonly NativePositionProbeResult[]> {
  validateN02Packet(packet);
  const cached = getDeviceCache(device);
  const pipeline = await getPipeline(device, cached, shaderCode);
  const bindings = getBindings(device, cached, packet);
  let clipTexture: GPUTexture | undefined;
  let localTexture: GPUTexture | undefined;
  let readback: GPUBuffer | undefined;

  try {
    for (const write of packet.writes) {
      device.queue.writeBuffer(
        bindings.buffers.get(write.resourceId)!,
        write.byteOffset,
        write.bytes,
      );
    }
    const textureDescriptor: GPUTextureDescriptor = {
      size: { width: 4, height: 1 },
      format: 'rgba32float',
      usage: TEXTURE_RENDER_ATTACHMENT | TEXTURE_COPY_SOURCE,
    };
    clipTexture = device.createTexture({
      ...textureDescriptor,
      label: 'vector-studio/p1-position-probe/clip',
    });
    localTexture = device.createTexture({
      ...textureDescriptor,
      label: 'vector-studio/p1-position-probe/local',
    });
    readback = device.createBuffer({
      label: 'vector-studio/p1-position-probe/readback',
      size: ROW_BYTES * 2,
      usage: BUFFER_MAP_READ | BUFFER_COPY_DESTINATION,
    });

    const encoder = device.createCommandEncoder({ label: 'vector-studio/p1-position-probe' });
    const pass = encoder.beginRenderPass({
      colorAttachments: [clipTexture, localTexture].map((texture) => ({
        view: texture.createView(),
        clearValue: { r: 0, g: 0, b: 0, a: 0 },
        loadOp: 'clear' as const,
        storeOp: 'store' as const,
      })),
    });
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bindings.bindGroup);
    pass.draw(4, 1, 0, packet.draws[0]!.first);
    pass.end();
    encoder.copyTextureToBuffer(
      { texture: clipTexture },
      { buffer: readback, offset: 0, bytesPerRow: ROW_BYTES },
      { width: 4, height: 1 },
    );
    encoder.copyTextureToBuffer(
      { texture: localTexture },
      { buffer: readback, offset: ROW_BYTES, bytesPerRow: ROW_BYTES },
      { width: 4, height: 1 },
    );
    device.queue.submit([encoder.finish()]);

    await readback.mapAsync(MAP_READ);
    const values = new Float32Array(readback.getMappedRange());
    const results: NativePositionProbeResult[] = [];
    for (let index = 0; index < 4; index += 1) {
      const clipOffset = index * 4;
      const localOffset = ROW_BYTES / 4 + index * 4;
      const clipW = values[clipOffset + 3]!;
      results.push(
        Object.freeze({
          x: ((values[clipOffset]! / clipW + 1) * packet.frame.width) / 2,
          y: ((1 - values[clipOffset + 1]! / clipW) * packet.frame.height) / 2,
          localX: values[localOffset]!,
          localY: values[localOffset + 1]!,
        }),
      );
    }
    readback.unmap();
    return Object.freeze(results);
  } finally {
    if (readback?.mapState === 'mapped') readback.unmap();
    readback?.destroy();
    clipTexture?.destroy();
    localTexture?.destroy();
  }
}

/** Destroys retained test buffers and drops this device's pipeline/layout cache. */
export function disposePositionProbe(device: GPUDevice): void {
  const cached = deviceCaches.get(device);
  if (cached === undefined) return;
  deviceCaches.delete(device);
  for (const buffer of cached.bindings?.buffers.values() ?? []) buffer.destroy();
}

function instrumentProductionShader(shaderCode: string): string {
  const first = shaderCode.indexOf(PRODUCTION_VERTEX_HEADER);
  if (first < 0 || first !== shaderCode.lastIndexOf(PRODUCTION_VERTEX_HEADER)) {
    throw new TypeError('Position probe requires exactly the production vertex entry header.');
  }
  return shaderCode.replace(PRODUCTION_VERTEX_HEADER, PROBE_VERTEX_HEADER) + PROBE_SHADER_SUFFIX;
}

function getDeviceCache(device: GPUDevice): DeviceProbeCache {
  let cached = deviceCaches.get(device);
  if (cached !== undefined) return cached;
  const bindGroupLayout = device.createBindGroupLayout({
    label: 'vector-studio/p1-position-probe/layout',
    entries: RESOURCE_IDS.map((id, binding) => ({
      binding,
      visibility: SHADER_STAGE_VERTEX,
      buffer: { type: id === 'frame' ? ('uniform' as const) : ('read-only-storage' as const) },
    })),
  });
  cached = {
    bindGroupLayout,
    pipelineLayout: device.createPipelineLayout({ bindGroupLayouts: [bindGroupLayout] }),
    pipelines: new Map(),
  };
  deviceCaches.set(device, cached);
  void device.lost.then(() => disposePositionProbe(device));
  return cached;
}

function getPipeline(
  device: GPUDevice,
  cached: DeviceProbeCache,
  shaderCode: string,
): Promise<GPURenderPipeline> {
  let pipeline = cached.pipelines.get(shaderCode);
  if (pipeline === undefined) {
    pipeline = createPipeline(
      device,
      cached.pipelineLayout,
      instrumentProductionShader(shaderCode),
    );
    cached.pipelines.set(shaderCode, pipeline);
    void pipeline.catch(() => cached.pipelines.delete(shaderCode));
  }
  return pipeline;
}

function getBindings(
  device: GPUDevice,
  cached: DeviceProbeCache,
  packet: PrimitivePacket,
): ProbeBindings {
  if (cached.bindings !== undefined) return cached.bindings;
  const buffers = new Map<PrimitiveResourceId, GPUBuffer>();
  try {
    for (const resource of packet.resources) {
      buffers.set(
        resource.id,
        device.createBuffer({
          label: `vector-studio/p1-position-probe/${resource.id}`,
          size: resource.capacityBytes,
          usage:
            (resource.id === 'frame' ? BUFFER_UNIFORM : BUFFER_STORAGE) | BUFFER_COPY_DESTINATION,
        }),
      );
    }
    cached.bindings = {
      buffers,
      bindGroup: device.createBindGroup({
        label: 'vector-studio/p1-position-probe/bind-group',
        layout: cached.bindGroupLayout,
        entries: packet.resources.map((resource, binding) => ({
          binding,
          resource: { buffer: buffers.get(resource.id)!, size: resource.capacityBytes },
        })),
      }),
    };
    return cached.bindings;
  } catch (error) {
    for (const buffer of buffers.values()) buffer.destroy();
    throw error;
  }
}

async function createPipeline(
  device: GPUDevice,
  layout: GPUPipelineLayout,
  code: string,
): Promise<GPURenderPipeline> {
  const module = device.createShaderModule({
    label: 'vector-studio/p1-position-probe/shader',
    code,
  });
  const pipeline = await device.createRenderPipelineAsync({
    label: 'vector-studio/p1-position-probe/pipeline',
    layout,
    vertex: { module, entryPoint: 'positionProbeVertex' },
    fragment: {
      module,
      entryPoint: 'positionProbeFragment',
      targets: [{ format: 'rgba32float' }, { format: 'rgba32float' }],
    },
    primitive: { topology: 'point-list' },
  });
  return pipeline;
}

function validateN02Packet(packet: PrimitivePacket): void {
  if (packet.layoutVersion !== 1 || packet.mode !== 'reconstruct') {
    throw new TypeError('Position probe accepts only packet-v1 reconstruction packets.');
  }
  if (packet.resources.length !== RESOURCE_IDS.length) {
    throw new TypeError('Position probe requires all five packet resources.');
  }
  for (let index = 0; index < RESOURCE_IDS.length; index += 1) {
    const resource = packet.resources[index]!;
    const expectedId = RESOURCE_IDS[index]!;
    if (
      resource.id !== expectedId ||
      resource.capacityBytes !== N02_INITIAL_CAPACITIES[expectedId]
    ) {
      throw new TypeError('Position probe requires the fixed initial N02 resource layout.');
    }
  }
  if (packet.draws.length !== 1 || packet.draws[0]!.count !== 1) {
    throw new TypeError('Position probe requires one visible N02 primitive.');
  }
  if (packet.writes.length !== RESOURCE_IDS.length) {
    throw new TypeError('Position probe requires one reconstruct write for every resource.');
  }
  for (let index = 0; index < RESOURCE_IDS.length; index += 1) {
    const write = packet.writes[index]!;
    const resource = packet.resources[index]!;
    if (
      write.resourceId !== resource.id ||
      write.incarnation !== resource.incarnation ||
      write.byteOffset !== 0 ||
      write.bytes.byteLength !== N02_RECONSTRUCT_WRITES[resource.id]
    ) {
      throw new TypeError('Position probe requires complete single-slot N02 reconstruct writes.');
    }
  }
}
