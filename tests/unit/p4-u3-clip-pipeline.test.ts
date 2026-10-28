import type { RenderNodeSnapshot, SceneAffine, SceneClip } from '@vector-studio/contracts';
import {
  PrimitiveRendererService,
  ResourceAccounting,
  type PrimitivePacket,
  type PrimitiveSubmitResult,
  type PrimitiveTarget,
} from '@vector-studio/renderer-core';
import { describe, expect, it, vi } from 'vitest';

import {
  CLIP_STATE_SIZE,
  MESH_FILL_CLIP_SHADER,
  MESH_FILL_CLIP_SHADER_KEY,
  MESH_JOINT_CLIP_SHADER_KEY,
  PRIMITIVE_ANALYTIC_CLIP_SHADER,
  PRIMITIVE_ANALYTIC_CLIP_SHADER_KEY,
  clipStateStride,
  clipVariantKey,
  packClipFrame,
  packClipState,
} from '../../packages/renderer-webgpu/src/clip-pipeline.js';
import { MESH_FILL_SHADER } from '../../packages/renderer-webgpu/src/mesh-fill-shader.js';
import { meshPipelineKey } from '../../packages/renderer-webgpu/src/mesh-pipeline.js';
import { createNativePrimitiveSceneCreation } from '../../packages/renderer-webgpu/src/native-primitive-scene.js';
import { PRIMITIVE_ANALYTIC_SHADER } from '../../packages/renderer-webgpu/src/primitive-analytic-shader.js';
import { primitivePipelineKey } from '../../packages/renderer-webgpu/src/primitive-pipeline.js';
import type { WebGpuCanvasContextPort } from '../../packages/renderer-webgpu/src/webgpu-platform.js';
import {
  ScriptedStrokeMeshPort,
  createStrokeHarness,
  strokedNode,
} from '../support/st-u6-stroke-harness.js';
import { createCountingPort, pathNode } from '../support/v3a-path-harness.js';

// P4 contract (docs/plans/p4-clip-mask.md), unit U3: the rect-clip pipeline variants (section
// 4, Pipelines), their clip block (P4-K1), the clip bind group at group 1 with a per-draw
// dynamic offset, change-only record writes (P4-A06), fail-closed clipped draws without the
// variants, the `clips: 'rect'` service option, and the stroked path under a clip owed by U2.
// Fake device seams only; the rendered evidence (P4-A02, A09) is U5's headed run.

type Call = readonly [string, ...unknown[]];
const IDENTITY: SceneAffine = [1, 0, 0, 1, 0, 0];

function nativeFixture(options: Readonly<{ failPipeline?: string }> = {}) {
  const calls: Call[] = [];
  const pipelineLabels: string[] = [];
  const descriptors: GPURenderPipelineDescriptor[] = [];
  const modules: string[] = [];
  const writes: { label: string; offset: number; bytes: number }[] = [];
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
      size: descriptor.size,
      destroy: vi.fn(),
    })),
    createBindGroupLayout: vi.fn((descriptor: GPUBindGroupLayoutDescriptor) => ({
      label: descriptor.label,
    })),
    createPipelineLayout: vi.fn((descriptor: GPUPipelineLayoutDescriptor) => ({
      label: descriptor.label,
      groups: [...descriptor.bindGroupLayouts],
    })),
    createBindGroup: vi.fn((descriptor: GPUBindGroupDescriptor) => ({ label: descriptor.label })),
    createShaderModule: vi.fn((descriptor: GPUShaderModuleDescriptor) => {
      modules.push(descriptor.code);
      return { label: descriptor.label };
    }),
    createRenderPipelineAsync: vi.fn((descriptor: GPURenderPipelineDescriptor) => {
      const label = descriptor.label ?? '';
      if (options.failPipeline !== undefined && label.includes(options.failPipeline)) {
        return Promise.reject(new Error('injected pipeline failure'));
      }
      pipelineLabels.push(label);
      descriptors.push(descriptor);
      return Promise.resolve({ label });
    }),
    createTexture: vi.fn(() => ({ createView: vi.fn(() => ({})), destroy: vi.fn() })),
    createCommandEncoder: vi.fn(() => ({
      beginRenderPass: vi.fn(() => ({
        setPipeline: (pipeline: { label: string }) => calls.push(['setPipeline', pipeline.label]),
        setBindGroup: (index: number, group: { label: string }, offsets?: number[]) =>
          calls.push(['setBindGroup', index, group.label, ...(offsets ?? [])]),
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
      writeBuffer: vi.fn((buffer: { label: string }, offset: number, bytes: Uint8Array) =>
        writes.push({ label: buffer.label, offset, bytes: bytes.byteLength }),
      ),
      submit: vi.fn(),
      onSubmittedWorkDone: vi.fn(() => new Promise<void>(() => {})),
    },
  } as unknown as GPUDevice;
  const context = {
    native: { getCurrentTexture: () => ({ createView: () => ({}) }) },
    configure: vi.fn(),
    unconfigure: vi.fn(),
  } as unknown as WebGpuCanvasContextPort;
  return { device, context, calls, pipelineLabels, descriptors, modules, writes };
}

async function nativeScene(
  fixture: ReturnType<typeof nativeFixture>,
  options: Readonly<{ meshPipeline?: boolean; clipPipeline?: boolean }> = {
    meshPipeline: true,
    clipPipeline: true,
  },
) {
  const accounting = new ResourceAccounting();
  const creation = createNativePrimitiveSceneCreation(
    fixture.device,
    fixture.context,
    'bgra8unorm',
    1,
    accounting,
    options,
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

function group(
  id: string,
  children: readonly string[],
  clip: SceneClip,
  parentId: string | null = null,
  transform: SceneAffine = IDENTITY,
): RenderNodeSnapshot {
  return { id, parentId, transform, visible: true, opacity: 1, kind: 'container', clip, children };
}

function box(id: string, parentId: string | null, x: number): RenderNodeSnapshot {
  return {
    id,
    parentId,
    transform: [1, 0, 0, 1, x, 20],
    visible: true,
    opacity: 1,
    kind: 'primitive',
    geometry: { kind: 'rectangle', width: 10, height: 10, cornerRadii: [0, 0, 0, 0] },
    style: { fill: { r: 1, g: 0, b: 0, a: 1 }, stroke: null },
  };
}

const clipRect = (x: number, y: number, width: number, height: number): SceneClip => ({
  kind: 'rect',
  x,
  y,
  width,
  height,
});

/** Unclipped box, a clipped box and a clipped joint path, then an unclipped box. */
function clippedScene() {
  return createStrokeHarness({
    fillPort: createCountingPort(),
    strokePort: new ScriptedStrokeMeshPort(),
    clips: 'rect',
    nodes: [
      box('u0', null, 0),
      group('c', ['b', 'a'], clipRect(15, 0, 100, 100)),
      box('b', 'c', 20),
      strokedNode('a', 40, { opacity: 0.5, parentId: 'c' }),
      box('u1', null, 200),
    ],
  });
}

const encodeCalls = ['setPipeline', 'setBindGroup', 'drawIndexed', 'draw'];

describe('P4 U3 clip shader variants (section 4, Pipelines; P4-K1)', () => {
  it('keeps the base modules and keys, and suffixes the variants', () => {
    expect(PRIMITIVE_ANALYTIC_SHADER).not.toContain('clipCoverage');
    expect(MESH_FILL_SHADER).not.toContain('clipCoverage');
    expect([
      PRIMITIVE_ANALYTIC_CLIP_SHADER_KEY,
      MESH_FILL_CLIP_SHADER_KEY,
      MESH_JOINT_CLIP_SHADER_KEY,
    ]).toEqual(['p1-analytic-v1+clip-v0', 'p3-mesh-fill-v0+clip-v0', 'p3-mesh-joint-v0+clip-v0']);
    expect(clipVariantKey(primitivePipelineKey('bgra8unorm', 4, true))).toEqual({
      ...primitivePipelineKey('bgra8unorm', 4, true),
      shaderKey: 'p1-analytic-v1+clip-v0',
      layoutKey: 'p1-packet-v1+p4-clip-v0',
    });
    expect(clipVariantKey(meshPipelineKey('bgra8unorm', 1, 'joint')).shaderKey).toBe(
      'p3-mesh-joint-v0+clip-v0',
    );
  });

  it('wraps each fragment entry point once and keeps every other line of the base module', () => {
    const entries = (code: string) =>
      code.match(/@fragment\s+fn (\w+)/g)?.map((m) => m.split(' ').pop());
    expect(entries(PRIMITIVE_ANALYTIC_CLIP_SHADER)).toEqual(['fragmentMain']);
    expect(entries(MESH_FILL_CLIP_SHADER)).toEqual(['meshFragmentMain', 'meshJointFragmentMain']);
    expect(PRIMITIVE_ANALYTIC_CLIP_SHADER).toContain('return shadePrimitive(input) * clip;');
    expect(MESH_FILL_CLIP_SHADER).toContain('return meshShade(input) * clip;');
    // The joint fill runs its formula with o·k, so the following stroke draw (also × k)
    // composites as the clipped group.
    expect(MESH_FILL_CLIP_SHADER).toContain('let opacity = fill.opacity * clip;');
    // The clipped joint entry is a copy of the base body with only o replaced by o·k, so a later
    // change to the base formula fails here instead of diverging silently.
    const body = (code: string, header: string) => {
      const start = code.indexOf(header);
      return code.slice(code.indexOf('{', start) + 1, code.indexOf('\n}\n', start));
    };
    const baseJoint = body(MESH_FILL_SHADER, 'fn meshJointFragmentMain(')
      .split('\n')
      .filter((line) => !line.trim().startsWith('//'));
    const clipJoint = body(MESH_FILL_CLIP_SHADER, '@fragment\nfn meshJointFragmentMain(').split(
      '\n',
    );
    expect(clipJoint.filter((line) => !line.includes('clip'))).toEqual(
      baseJoint.filter((line) => !line.includes('let opacity = fill.opacity;')),
    );
    // Base text survives verbatim apart from the renamed entry headers.
    const strip = (code: string) =>
      code
        .replace(/@fragment\nfn \w+\((input: \w+)\) -> @location\(0\) vec4f \{/g, 'HEADER')
        .replace(/fn \w+\((input: \w+)\) -> vec4f \{/g, 'HEADER');
    expect(strip(PRIMITIVE_ANALYTIC_CLIP_SHADER).startsWith(strip(PRIMITIVE_ANALYTIC_SHADER))).toBe(
      true,
    );
    expect(strip(MESH_FILL_CLIP_SHADER).startsWith(strip(MESH_FILL_SHADER))).toBe(true);
    // The loop bound comes from a uniform and is capped at the depth limit.
    expect(PRIMITIVE_ANALYTIC_CLIP_SHADER).toContain('min(clipState.rectCount, 32u)');
  });
});

describe('P4 U3 clip record packing', () => {
  const record = {
    index: 1,
    chainKey: '1:c;',
    rects: [{ toLocal: [2, 0, 0, 0.5, -10, 4] as SceneAffine, width: 30, height: 40 }],
    masks: [],
  };

  it('rebases the translation to the origin in binary64 and rounds once', () => {
    const bytes = packClipState(record, { x: 1e6, y: -2e6 })!;
    expect(bytes.byteLength).toBe(CLIP_STATE_SIZE);
    const view = new DataView(bytes.buffer);
    expect(view.getUint32(0, true)).toBe(1);
    const lanes = Array.from({ length: 8 }, (_, lane) => view.getFloat32(16 + lane * 4, true));
    expect(lanes).toEqual([2, 0, 0, 0.5, Math.fround(2e6 - 10), Math.fround(-1e6 + 4), 30, 40]);
  });

  it('refuses mask levels, no or more than 32 rects, negative sizes and non-finite lanes', () => {
    expect(packClipState({ ...record, masks: ['m'] }, { x: 0, y: 0 })).toBeNull();
    expect(packClipState({ ...record, rects: [] }, { x: 0, y: 0 })).toBeNull();
    expect(
      packClipState({ ...record, rects: [{ ...record.rects[0]!, width: -1 }] }, { x: 0, y: 0 }),
    ).toBeNull();
    expect(
      packClipState(
        { ...record, rects: Array.from({ length: 33 }, () => record.rects[0]!) },
        {
          x: 0,
          y: 0,
        },
      ),
    ).toBeNull();
    expect(
      packClipState(
        { ...record, rects: [{ ...record.rects[0]!, toLocal: [1e39, 0, 0, 1, 0, 0] }] },
        { x: 0, y: 0 },
      ),
    ).toBeNull();
  });

  it('packs the frame as camera minus origin and the world size of a physical pixel', () => {
    const part = {
      layoutVersion: 0 as const,
      states: [],
      maxIndex: 1,
      masks: [],
      origin: { x: 1000, y: 2000 },
      camera: { x: 1010.5, y: 1990, zoom: 4 },
    };
    expect(Array.from(packClipFrame(part, 2)!)).toEqual([10.5, -10, 0.125, 0]);
    expect(packClipFrame({ ...part, camera: { ...part.camera, zoom: 0 } }, 1)).toBeNull();
    expect(clipStateStride(256)).toBe(1280);
    expect(clipStateStride(64)).toBe(1088);
  });
});

describe('P4 U3 pipeline creation', () => {
  it('creates the variants beside the base pipelines, from their own modules and layouts', async () => {
    const fixture = nativeFixture();
    const { scene, creation, accounting } = await nativeScene(fixture);
    expect(scene).toMatchObject({
      clipPipelineAvailable: true,
      meshPipelineAvailable: true,
      pipelinesCreated: 7,
      shaderModulesCreated: 5,
    });
    expect(fixture.pipelineLabels).toEqual([
      'vector-studio/p1-analytic-primitive-stencil-4x',
      'vector-studio/p3-mesh-fill-4x',
      'vector-studio/p3-mesh-joint-4x',
      'vector-studio/p3-mesh-stencil-reset-4x',
      'vector-studio/p1-analytic-primitive-stencil-4x+clip-v0',
      'vector-studio/p3-mesh-fill-4x+clip-v0',
      'vector-studio/p3-mesh-joint-4x+clip-v0',
    ]);
    const byLabel = (label: string) =>
      fixture.descriptors.find((descriptor) => descriptor.label === label)!;
    const base = byLabel('vector-studio/p1-analytic-primitive-stencil-4x');
    const clipped = byLabel('vector-studio/p1-analytic-primitive-stencil-4x+clip-v0');
    expect(clipped.vertex.module).not.toBe(base.vertex.module);
    expect({ ...clipped, label: '', layout: null, vertex: null, fragment: null }).toEqual({
      ...base,
      label: '',
      layout: null,
      vertex: null,
      fragment: null,
    });
    // Group 0 is the base layout's own bind group layout; group 1 is the clip layout.
    const groups = (descriptor: GPURenderPipelineDescriptor) =>
      (descriptor.layout as unknown as { groups: { label: string }[] }).groups.map(
        (layout) => layout.label,
      );
    expect(groups(clipped)).toEqual([
      'vector-studio/p1-primitive-packet-layout',
      'vector-studio/p4-clip-layout',
    ]);
    expect(groups(byLabel('vector-studio/p3-mesh-joint-4x+clip-v0'))).toEqual([
      'vector-studio/p3-mesh-packet-layout',
      'vector-studio/p4-clip-layout',
    ]);
    expect(fixture.modules.filter((code) => code.includes('clipCoverage'))).toEqual([
      PRIMITIVE_ANALYTIC_CLIP_SHADER,
      MESH_FILL_CLIP_SHADER,
    ]);
    expect(accounting.snapshot().byCategory['render-pipeline'].live).toBe(7);
    creation.dispose();
    expect(accounting.snapshot().live).toBe(0);
  });

  it('creates nothing extra without the option (P4-A09)', async () => {
    const fixture = nativeFixture();
    const { scene, creation } = await nativeScene(fixture, { meshPipeline: true });
    expect(scene).toMatchObject({
      clipPipelineAvailable: false,
      pipelinesCreated: 4,
      shaderModulesCreated: 3,
    });
    expect(fixture.modules.some((code) => code.includes('clipCoverage'))).toBe(false);
    creation.dispose();
  });

  it('creates the analytic variant only without the mesh path', async () => {
    const fixture = nativeFixture();
    const { scene, creation } = await nativeScene(fixture, { clipPipeline: true });
    expect(scene).toMatchObject({
      clipPipelineAvailable: true,
      pipelinesCreated: 2,
      shaderModulesCreated: 2,
    });
    expect(fixture.pipelineLabels).toEqual([
      'vector-studio/p1-analytic-primitive-4x',
      'vector-studio/p1-analytic-primitive-4x+clip-v0',
    ]);
    creation.dispose();
  });

  it('a failed variant leaves the clip path unavailable and the rest intact', async () => {
    const fixture = nativeFixture({ failPipeline: 'p3-mesh-joint-4x+clip' });
    const { scene, creation, accounting } = await nativeScene(fixture);
    expect(scene).toMatchObject({
      clipPipelineAvailable: false,
      meshPipelineAvailable: true,
      pipelinesCreated: 4,
    });
    expect(accounting.snapshot().byCategory['render-pipeline'].live).toBe(4);
    creation.dispose();
    expect(accounting.snapshot().live).toBe(0);
  });
});

describe('P4 U3 draw encoding', () => {
  it('encodes clipped draws with the variants and the state offset, unclipped draws as before', async () => {
    const fixture = nativeFixture();
    const { scene, creation, target } = await nativeScene(fixture);
    const h = clippedScene();
    const packet = h.source.prepare(target)!;
    expect(packet.clip?.maxIndex).toBe(1);
    expect(packet.clip?.states.map((state) => state.rects.length)).toEqual([1]);
    expect(packet.draws.map((draw) => draw.clipState ?? 0)).toEqual([0, 1, 0]);
    // U2's owed check: the joint fill draw and the stroke draw of the clipped path share it.
    expect(packet.mesh!.draws.map((draw) => [draw.composite ?? 'plain', draw.clipState])).toEqual([
      ['joint-fill', 1],
      ['plain', 1],
    ]);
    submitted(scene.submitPrimitivePacket(packet));
    const p1 = 'vector-studio/p1-analytic-primitive-stencil-4x';
    const clipGroup = 'primitive/1/clip-states-1/bind-group';
    const encoded = fixture.calls
      .filter(([name]) => encodeCalls.includes(name))
      .map((call) => (call[0] === 'setBindGroup' && call[1] === 0 ? ['setBindGroup', 0] : call));
    expect(encoded).toEqual([
      ['setPipeline', p1],
      ['setBindGroup', 0],
      ['drawIndexed', 6, 1, 0, 0, 0],
      ['setPipeline', `${p1}+clip-v0`],
      ['setBindGroup', 1, clipGroup, 1280],
      ['drawIndexed', 6, 1, 0, 0, 1],
      ['setPipeline', 'vector-studio/p3-mesh-joint-4x+clip-v0'],
      ['setBindGroup', 0],
      ['setBindGroup', 1, clipGroup, 1280],
      ['draw', expect.any(Number), 1, expect.any(Number), expect.any(Number)],
      ['setPipeline', 'vector-studio/p3-mesh-fill-4x+clip-v0'],
      ['draw', expect.any(Number), 1, expect.any(Number), expect.any(Number)],
      ['setPipeline', p1],
      ['setBindGroup', 0],
      ['drawIndexed', 6, 1, 0, 0, 2],
    ]);
    creation.dispose();
  });

  it('writes the frame lanes and only changed state records (P4-A06)', async () => {
    const fixture = nativeFixture();
    const { scene, creation, target, accounting } = await nativeScene(fixture);
    const h = clippedScene();
    submitted(scene.submitPrimitivePacket(h.source.prepare(target)!));
    const clipWrites = () => fixture.writes.filter(({ label }) => label.includes('clip-states'));
    expect(clipWrites()).toEqual([
      { label: 'primitive/1/clip-states-1', offset: 0, bytes: 16 },
      { label: 'primitive/1/clip-states-1', offset: 1280, bytes: CLIP_STATE_SIZE },
    ]);
    expect(accounting.snapshot().byCategory.buffer.live).toBeGreaterThan(0);
    const scenePort = scene as unknown as { clipStateWritesForTesting: number };
    expect(scenePort.clipStateWritesForTesting).toBe(1);
    // A camera pan changes the frame lanes only; the record stays (same origin).
    h.mirror.setCamera({ position: { x: 1, y: 0 }, zoom: 1 });
    const panned = h.source.prepare(target)!;
    fixture.writes.length = 0;
    submitted(scene.submitPrimitivePacket(panned));
    expect(clipWrites()).toEqual([{ label: 'primitive/1/clip-states-1', offset: 0, bytes: 16 }]);
    expect(scenePort.clipStateWritesForTesting).toBe(1);
    creation.dispose();
    expect(accounting.snapshot().live).toBe(0);
  });

  it('refuses a clipped draw whose state the clip part lacks', async () => {
    const fixture = nativeFixture();
    const { scene, creation, target } = await nativeScene(fixture);
    const packet = clippedScene().source.prepare(target)!;
    const missing = {
      ...packet,
      draws: packet.draws.map((draw) => (draw.clipState === 1 ? { ...draw, clipState: 2 } : draw)),
    } as PrimitivePacket;
    expect(scene.submitPrimitivePacket(missing)).toEqual({
      status: 'failed',
      reason: 'invalid-packet',
    });
    const withoutPart = { ...packet, clip: undefined };
    expect(scene.submitPrimitivePacket(withoutPart as unknown as PrimitivePacket)).toEqual({
      status: 'failed',
      reason: 'invalid-packet',
    });
    creation.dispose();
  });

  it('grows the buffer past its capacity and releases it once no clip is left', async () => {
    const fixture = nativeFixture();
    const { scene, creation, target, accounting } = await nativeScene(fixture);
    const created = (fixture.device.createBuffer as unknown as ReturnType<typeof vi.fn>).mock
      .results;
    const clipBuffers = () =>
      created
        .map((result) => result.value as { label: string; destroy: ReturnType<typeof vi.fn> })
        .filter(({ label }) => label.includes('clip-states'));
    const live = () => clipBuffers().filter(({ destroy }) => destroy.mock.calls.length === 0);
    const h = clippedScene();
    submitted(scene.submitPrimitivePacket(h.source.prepare(target)!));
    expect(live().map(({ label }) => label)).toEqual(['primitive/1/clip-states-1']);
    // Three new clipped siblings take states 2..4 (state 1 is held until the frame ends), past
    // the first buffer's capacity of 1.
    const nodes = [0, 1, 2].flatMap((index) => [
      group(`g${index}`, [`k${index}`], clipRect(index * 30, 0, 20, 100)),
      box(`k${index}`, `g${index}`, index * 30 + 5),
    ]);
    expect(h.replace(nodes).status).toBe('applied');
    const grown = h.source.prepare(target)!;
    expect(grown.clip?.maxIndex).toBe(4);
    submitted(scene.submitPrimitivePacket(grown));
    expect(live().map(({ label }) => label)).toEqual(['primitive/1/clip-states-2']);
    expect(h.replace([box('u', null, 0)]).status).toBe('applied');
    submitted(scene.submitPrimitivePacket(h.source.prepare(target)!));
    expect(live()).toEqual([]);
    expect(clipBuffers()).toHaveLength(2);
    creation.dispose();
    expect(accounting.snapshot().live).toBe(0);
  });

  it('checks a clip part without clipped draws and writes nothing', async () => {
    const fixture = nativeFixture();
    const { scene, creation, target } = await nativeScene(fixture);
    const packet = clippedScene().source.prepare(target)!;
    const unclipped = <T extends { clipState?: number }>(draw: T) => {
      const copy = { ...draw };
      delete copy.clipState;
      return copy;
    };
    const unclippedDraws = {
      ...packet,
      draws: packet.draws.map(unclipped),
      mesh: { ...packet.mesh!, draws: packet.mesh!.draws.map(unclipped) },
    } as unknown as PrimitivePacket;
    submitted(scene.submitPrimitivePacket(unclippedDraws));
    expect(fixture.writes.some(({ label }) => label.includes('clip-states'))).toBe(false);
    const malformed = {
      ...unclippedDraws,
      clip: { ...packet.clip!, maxIndex: 2 },
    } as unknown as PrimitivePacket;
    expect(scene.submitPrimitivePacket(malformed)).toEqual({
      status: 'failed',
      reason: 'invalid-packet',
    });
    creation.dispose();
  });

  it('reports allocation-failed when the clip buffer cannot be created', async () => {
    const fixture = nativeFixture();
    const { scene, creation, target } = await nativeScene(fixture);
    (fixture.device.createBuffer as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      (descriptor: GPUBufferDescriptor) => {
        if (descriptor.label?.includes('clip-states') === true) throw new Error('out of memory');
        return { label: descriptor.label, size: descriptor.size, destroy: vi.fn() };
      },
    );
    expect(scene.submitPrimitivePacket(clippedScene().source.prepare(target)!)).toEqual({
      status: 'failed',
      reason: 'allocation-failed',
    });
    creation.dispose();
  });

  it('does not draw clipped draws without the variants (fail closed)', async () => {
    const fixture = nativeFixture();
    const { scene, creation, target } = await nativeScene(fixture, { meshPipeline: true });
    submitted(scene.submitPrimitivePacket(clippedScene().source.prepare(target)!));
    const draws = fixture.calls.filter(([name]) => name === 'drawIndexed' || name === 'draw');
    expect(draws).toEqual([
      ['drawIndexed', 6, 1, 0, 0, 0],
      ['drawIndexed', 6, 1, 0, 0, 2],
    ]);
    expect(fixture.writes.some(({ label }) => label.includes('clip-states'))).toBe(false);
    creation.dispose();
  });
});

describe("P4 U3 service option clips: 'rect'", () => {
  const invalidate = { invalidate: () => undefined, setMode: () => undefined };
  const snapshot = (clip: SceneClip, children: readonly RenderNodeSnapshot[] = []) => ({
    identity: { documentId: 'p4-u3', pageId: 'page' },
    revision: 1,
    rootOrder: ['c'],
    nodes: [
      group(
        'c',
        children.map((node) => node.id),
        clip,
      ),
      ...children,
    ],
  });

  it('draws rect clips, still rejects mask containers, and asks for the clip pipeline', () => {
    const service = new PrimitiveRendererService(invalidate, { clips: 'rect' });
    expect(service.requiresClipPipeline).toBe(true);
    expect(
      service.replaceSnapshot(snapshot(clipRect(0, 0, 10, 10), [box('b', 'c', 0)])),
    ).toMatchObject({ status: 'applied' });
    expect(service.replaceSnapshot({ ...snapshot({ kind: 'mask' }), revision: 2 })).toMatchObject({
      status: 'invalid-scene',
      reason: 'unsupported-feature',
    });
    service.dispose();
  });

  it('defaults to none: every non-null clip is unsupported and no clip pipeline is asked for', () => {
    const service = new PrimitiveRendererService(invalidate);
    expect(service.requiresClipPipeline).toBe(false);
    expect(service.replaceSnapshot(snapshot(clipRect(0, 0, 10, 10)))).toMatchObject({
      status: 'invalid-scene',
      reason: 'unsupported-feature',
    });
    expect(
      () => new PrimitiveRendererService(invalidate, { clips: 'mask' as unknown as 'rect' }),
    ).toThrow(TypeError);
    service.dispose();
  });

  it('a path under a clip: fill and stroke draws at one sequence share position and state', () => {
    const h = createStrokeHarness({
      fillPort: createCountingPort(),
      strokePort: new ScriptedStrokeMeshPort(),
      clips: 'rect',
      nodes: [
        group('c', ['s', 'f'], clipRect(0, 0, 100, 100)),
        strokedNode('s', 20, { parentId: 'c' }),
        pathNode('f', 40, { parentId: 'c' }),
      ],
    });
    const target: PrimitiveTarget = {
      generation: 1,
      surfaceRevision: 1,
      width: 640,
      height: 360,
      devicePixelRatio: 1,
      sampleCount: 1,
      targetFormat: 'bgra8unorm',
    };
    const packet = h.source.prepare(target)!;
    const draws = packet.mesh!.draws;
    expect(draws).toHaveLength(3);
    expect(draws[0]!.position).toBe(draws[1]!.position);
    expect(draws.map((draw) => draw.clipState)).toEqual([1, 1, 1]);
  });
});
