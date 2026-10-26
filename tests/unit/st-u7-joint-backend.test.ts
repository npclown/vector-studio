import {
  ResourceAccounting,
  type PrimitivePacket,
  type PrimitiveSubmitResult,
  type PrimitiveTarget,
} from '@vector-studio/renderer-core';
import { describe, expect, it, vi } from 'vitest';

import {
  MESH_FILL_SHADER,
  MESH_FILL_SHADER_KEY,
  MESH_JOINT_SHADER_KEY,
} from '../../packages/renderer-webgpu/src/mesh-fill-shader.js';
import { meshPipelineKey } from '../../packages/renderer-webgpu/src/mesh-pipeline.js';
import { createNativePrimitiveSceneCreation } from '../../packages/renderer-webgpu/src/native-primitive-scene.js';
import type { WebGpuCanvasContextPort } from '../../packages/renderer-webgpu/src/webgpu-platform.js';
import {
  ScriptedStrokeMeshPort,
  createStrokeHarness,
  strokedNode,
} from '../support/st-u6-stroke-harness.js';
import { createCountingPort, pathNode, rectangleNode } from '../support/v3a-path-harness.js';

// P3 B2 ST-U7 addendum, unit ST-U7c, renderer-webgpu side (section 4.5): the joint pipeline
// over the existing mesh module (shaderKey p3-mesh-joint-v0, label p3-mesh-joint-<n>x), created
// at initialization beside the fill pipeline; generation-wide unavailability when either fails;
// the pipeline switch at a joint fill draw and back; the backend checks of the composite field
// and of word 15 - 1; and the shader's joint entry points, shared position helper, @invariant
// outputs and unchanged meshCoverage call. Fake device seams only; functional evidence, with
// precision UNVERIFIED against the 0.25 physical-pixel target.

type Call = readonly [string, ...unknown[]];

function nativeFixture(options: Readonly<{ failPipeline?: string }> = {}) {
  const calls: Call[] = [];
  const pipelineLabels: string[] = [];
  const descriptors: GPURenderPipelineDescriptor[] = [];
  const device = {
    limits: {
      minStorageBufferOffsetAlignment: 256,
      minUniformBufferOffsetAlignment: 256,
      maxStorageBufferBindingSize: 128 * 1024 * 1024,
      maxUniformBufferBindingSize: 65536,
      maxBufferSize: 256 * 1024 * 1024,
      maxStorageBuffersPerShaderStage: 8,
      maxUniformBuffersPerShaderStage: 12,
      maxBindingsPerBindGroup: 1000,
      maxBindGroups: 4,
    },
    createBuffer: vi.fn((descriptor: GPUBufferDescriptor) => ({
      label: descriptor.label,
      destroy: vi.fn(),
    })),
    createBindGroupLayout: vi.fn((descriptor: GPUBindGroupLayoutDescriptor) => ({
      label: descriptor.label,
    })),
    createPipelineLayout: vi.fn(() => ({})),
    createBindGroup: vi.fn((descriptor: GPUBindGroupDescriptor) => ({ label: descriptor.label })),
    createShaderModule: vi.fn(() => ({})),
    createRenderPipelineAsync: vi.fn((descriptor: GPURenderPipelineDescriptor) => {
      const label = descriptor.label ?? '';
      if (options.failPipeline !== undefined && label.includes(options.failPipeline)) {
        return Promise.reject(new Error('injected pipeline failure'));
      }
      pipelineLabels.push(label);
      descriptors.push(descriptor);
      return Promise.resolve({
        label,
        entryPoints: [descriptor.vertex.entryPoint, descriptor.fragment?.entryPoint],
      });
    }),
    createTexture: vi.fn(() => ({ createView: vi.fn(() => ({})), destroy: vi.fn() })),
    createCommandEncoder: vi.fn(() => ({
      beginRenderPass: vi.fn(() => ({
        setPipeline: (pipeline: { label: string }) => calls.push(['setPipeline', pipeline.label]),
        setBindGroup: (_index: number, group: { label: string }) =>
          calls.push(['setBindGroup', group.label]),
        setVertexBuffer: () => calls.push(['setVertexBuffer']),
        setIndexBuffer: () => calls.push(['setIndexBuffer']),
        drawIndexed: (...args: number[]) => calls.push(['drawIndexed', ...args]),
        draw: (...args: number[]) => calls.push(['draw', ...args]),
        setStencilReference: (reference: number) => calls.push(['setStencilReference', reference]),
        end: () => calls.push(['end']),
      })),
      finish: vi.fn(() => ({})),
    })),
    queue: {
      writeBuffer: vi.fn(),
      submit: vi.fn(),
      onSubmittedWorkDone: vi.fn(() => new Promise<void>(() => {})),
    },
  } as unknown as GPUDevice;
  const context = {
    native: { getCurrentTexture: () => ({ createView: () => ({}) }) },
    configure: vi.fn(),
    unconfigure: vi.fn(),
  } as unknown as WebGpuCanvasContextPort;
  return { device, context, calls, pipelineLabels, descriptors };
}

async function nativeScene(fixture: ReturnType<typeof nativeFixture>) {
  const accounting = new ResourceAccounting();
  const creation = createNativePrimitiveSceneCreation(
    fixture.device,
    fixture.context,
    'bgra8unorm',
    1,
    accounting,
    { meshPipeline: true },
  );
  const { scene } = await creation.result;
  const target: PrimitiveTarget = {
    generation: 1,
    surfaceRevision: 1,
    width: 640,
    height: 360,
    devicePixelRatio: 1,
    sampleCount: scene.sampleCount,
    targetFormat: 'bgra8unorm',
  };
  scene.setTarget(target);
  return { scene, creation, accounting, target };
}

function submitted(result: PrimitiveSubmitResult) {
  if (result.status !== 'submitted') throw new Error(`not submitted: ${JSON.stringify(result)}`);
  return result.receipt;
}

function jointScene() {
  return createStrokeHarness({
    fillPort: createCountingPort(),
    strokePort: new ScriptedStrokeMeshPort(),
    nodes: [
      rectangleNode('r0', 0),
      strokedNode('a', 20, { opacity: 0.5 }),
      pathNode('f', 40),
      strokedNode('b', 60, { opacity: 0.25 }),
    ],
  });
}

/** A copy of the packet with one mesh draw replaced. */
function withDraw(
  packet: PrimitivePacket,
  index: number,
  draw: Readonly<Record<string, unknown>>,
): PrimitivePacket {
  const draws = packet.mesh!.draws.map((value, at) => (at === index ? draw : value));
  return { ...packet, mesh: { ...packet.mesh!, draws } } as unknown as PrimitivePacket;
}

/** A copy of the packet whose meshInstances writes set word 15 of `slot` to `value`. */
function withWord15(packet: PrimitivePacket, slot: number, value: number): PrimitivePacket {
  const writes = packet.mesh!.writes.map((write) => {
    if (write.resourceId !== 'meshInstances') return write;
    const index = slot - write.byteOffset / 64;
    if (index < 0 || index >= write.records.length) return write;
    const bytes = write.bytes.slice();
    new DataView(bytes.buffer).setUint32(64 * index + 60, value, true);
    return { ...write, bytes };
  });
  return { ...packet, mesh: { ...packet.mesh!, writes } };
}

describe('ST-U7 joint pipeline creation (addendum section 4.5)', () => {
  it('creates the joint pipeline from the same module and layout, with its own key and label', async () => {
    const fixture = nativeFixture();
    const { scene, creation, accounting } = await nativeScene(fixture);
    expect(scene).toMatchObject({
      meshPipelineAvailable: true,
      // E17 section 3: the stencil reset pipeline and its module.
      pipelinesCreated: 4,
      shaderModulesCreated: 3,
    });
    expect(fixture.pipelineLabels).toEqual([
      'vector-studio/p1-analytic-primitive-stencil-4x',
      'vector-studio/p3-mesh-fill-4x',
      'vector-studio/p3-mesh-joint-4x',
      'vector-studio/p3-mesh-stencil-reset-4x',
    ]);
    const joint = fixture.descriptors.find((descriptor) => descriptor.label?.includes('joint'))!;
    const fill = fixture.descriptors.find((descriptor) => descriptor.label?.includes('mesh-fill'))!;
    expect(joint.vertex.module).toBe(fill.vertex.module);
    expect(joint.layout).toBe(fill.layout);
    expect([joint.vertex.entryPoint, joint.fragment!.entryPoint]).toEqual([
      'meshJointVertexMain',
      'meshJointFragmentMain',
    ]);
    expect(joint.fragment!.targets).toEqual(fill.fragment!.targets);
    expect(joint.primitive).toEqual(fill.primitive);
    expect(joint.multisample).toEqual(fill.multisample);
    expect(meshPipelineKey('bgra8unorm', 4, 'joint')).toEqual({
      ...meshPipelineKey('bgra8unorm', 4),
      shaderKey: 'p3-mesh-joint-v0',
    });
    expect([MESH_FILL_SHADER_KEY, MESH_JOINT_SHADER_KEY]).toEqual([
      'p3-mesh-fill-v0',
      'p3-mesh-joint-v0',
    ]);
    expect(accounting.snapshot().byCategory['render-pipeline'].live).toBe(4);
    creation.dispose();
    expect(accounting.snapshot().live).toBe(0);
  });

  for (const failing of ['p3-mesh-fill', 'p3-mesh-joint']) {
    it(`a failed ${failing} pipeline makes the mesh path unavailable for the generation`, async () => {
      const fixture = nativeFixture({ failPipeline: failing });
      const { scene, creation, accounting, target } = await nativeScene(fixture);
      expect(scene).toMatchObject({ meshPipelineAvailable: false, pipelinesCreated: 1 });
      expect(accounting.snapshot().byCategory['render-pipeline'].live).toBe(1);
      const h = jointScene();
      const receipt = submitted(scene.submitPrimitivePacket(h.source.prepare(target)!));
      expect(receipt.mesh).toEqual({ status: 'skipped' });
      expect(fixture.calls.filter(([name]) => name === 'draw')).toEqual([]);
      creation.dispose();
    });
  }
});

describe('ST-U7 joint draw encoding and validation (addendum section 4.5)', () => {
  it('switches to the joint pipeline at a joint fill draw and back for the next mesh draw', async () => {
    const fixture = nativeFixture();
    const { scene, creation, target } = await nativeScene(fixture);
    const h = jointScene();
    const packet = h.source.prepare(target)!;
    expect(packet.mesh!.draws.map((draw) => draw.composite ?? null)).toEqual([
      'joint-fill',
      null,
      null,
      'joint-fill',
      null,
    ]);
    submitted(scene.submitPrimitivePacket(packet));
    // E17 section 3: a mesh generation's analytic pipeline declares the stencil format.
    const p1 = 'vector-studio/p1-analytic-primitive-stencil-4x';
    const fill = 'vector-studio/p3-mesh-fill-4x';
    const joint = 'vector-studio/p3-mesh-joint-4x';
    const encoded = fixture.calls
      .filter(([name]) => ['setPipeline', 'drawIndexed', 'draw'].includes(name))
      .map(([name, label]) => (name === 'setPipeline' ? label : name));
    expect(encoded).toEqual([
      p1,
      'drawIndexed',
      joint,
      'draw',
      fill,
      'draw',
      'draw',
      joint,
      'draw',
      fill,
      'draw',
    ]);
    // The mesh bind group is set once: the joint pipeline shares it.
    expect(
      fixture.calls.filter(
        ([name, label]) => name === 'setBindGroup' && String(label).includes('mesh'),
      ),
    ).toHaveLength(1);
    creation.dispose();
  });

  it('rejects an unknown composite value and a joint draw whose word 15 - 1 is not a written instance', async () => {
    const fixture = nativeFixture();
    const { scene, creation, target } = await nativeScene(fixture);
    const h = jointScene();
    const packet = h.source.prepare(target)!;
    const draw = packet.mesh!.draws[0]!;
    const fillSlot = draw.instance;
    const reject = (bad: PrimitivePacket) =>
      expect(scene.submitPrimitivePacket(bad)).toEqual({
        status: 'failed',
        reason: 'invalid-packet',
      });
    reject(withDraw(packet, 0, { ...draw, composite: 'stroke-over' }));
    reject(withDraw(packet, 1, { ...packet.mesh!.draws[1]!, composite: null }));
    // Word 15 = 0 (no stroke record), past the instance capacity, or an unwritten instance.
    reject(withWord15(packet, fillSlot, 0));
    reject(withWord15(packet, fillSlot, 1 << 20));
    reject(withWord15(packet, fillSlot, 15));
    // A plain mesh draw is not checked against word 15.
    const plain = withDraw(packet, 0, {
      position: draw.position,
      instance: draw.instance,
      firstTriangle: draw.firstTriangle,
      triangleCount: draw.triangleCount,
    });
    expect(scene.submitPrimitivePacket(withWord15(plain, fillSlot, 0)).status).toBe('submitted');
    // The unmodified packet of a fresh source is accepted.
    const fresh = jointScene();
    const good = fresh.source.prepare(target)!;
    expect(submitted(scene.submitPrimitivePacket(good)).mesh).toMatchObject({
      status: 'submitted',
    });
    creation.dispose();
  });
});

describe('ST-U7 joint shader entry points (addendum section 4.5, ST-A18)', () => {
  it('keeps meshCoverage and its call, adds the joint entry points, and declares @invariant outputs', () => {
    expect(MESH_FILL_SHADER).toContain(
      'fn meshCoverage(p: vec2f, triangle: MeshTriangle, instance: MeshInstance) -> f32',
    );
    expect(MESH_FILL_SHADER).toContain('meshCoverage(input.position.xy, triangle, instance)');
    expect(MESH_FILL_SHADER).toContain('@builtin(position) @invariant position: vec4f');
    expect(MESH_FILL_SHADER).toContain('fn meshJointVertexMain(');
    expect(MESH_FILL_SHADER).toContain('fn meshJointFragmentMain(input: MeshVertexOutput)');
    expect(MESH_FILL_SHADER).toContain('fn meshJointCoverage(');
    // Both vertex entry points call the one position helper; the joint one selects the record first.
    expect(MESH_FILL_SHADER.match(/meshPositionNdc\(/gu)).toHaveLength(3);
    expect(MESH_FILL_SHADER).toContain(
      'select(instanceIndex, instances[instanceIndex].strokeLink - 1u, fromStroke)',
    );
    expect(MESH_FILL_SHADER).toContain('raw & JOINT_INDEX_MASK');
    // c_S: the stroke list at the fill record's listBase, with the stroke record's mapping.
    expect(MESH_FILL_SHADER).toContain('fill.listBase + triangle.role');
    expect(MESH_FILL_SHADER).toContain(
      'let factor = opacity * (1.0 - strokeAlpha) / (1.0 - opacity * strokeAlpha);',
    );
    expect(MESH_FILL_SHADER).not.toMatch(/sample_index|@interpolate\([^)]*sample|fwidth|dpdx/);
  });
});
