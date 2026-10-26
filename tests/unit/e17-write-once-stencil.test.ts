import { ResourceAccounting, type PrimitiveTarget } from '@vector-studio/renderer-core';
import { describe, expect, it, vi } from 'vitest';

import {
  createMeshPipelineDescriptor,
  createMeshStencilResetPipelineDescriptor,
  MESH_RENDER_STATE_KEY,
  MESH_STENCIL_REFERENCES,
  meshPipelineKey,
  meshStencilStep,
  meshWriteOnceStencilState,
} from '../../packages/renderer-webgpu/src/mesh-pipeline.js';
import { createNativePrimitiveSceneCreation } from '../../packages/renderer-webgpu/src/native-primitive-scene.js';
import {
  createPrimitivePipelineDescriptor,
  PRIMITIVE_RENDER_STATE_KEY,
  PRIMITIVE_STENCIL_RENDER_STATE_KEY,
  primitivePipelineKey,
} from '../../packages/renderer-webgpu/src/primitive-pipeline.js';
import type { WebGpuCanvasContextPort } from '../../packages/renderer-webgpu/src/webgpu-platform.js';
import { createCountingPort, createPathHarness, pathNode } from '../support/v3a-path-harness.js';

// E17 contract (docs/plans/d9-e17-mesh-write-once-coverage-contract.md), acceptance checks
// E17-A1 to E17-A3: the write-once stencil of mesh draws (E17-K2) in pipeline descriptors, frame
// encoding (main pass and E10's count pass) and attachment lifetime. Fake device seams only; the
// headed check is E17-A5.

type PassRecord = {
  descriptor: GPURenderPassDescriptor;
  calls: (readonly [string, ...unknown[]])[];
};

function fixture(options: Readonly<{ failLabel?: string; failTexture?: string }> = {}) {
  const passes: PassRecord[] = [];
  const descriptors: GPURenderPipelineDescriptor[] = [];
  const textures: { label: string; format: string; sampleCount: number; destroyed: boolean }[] = [];
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
      // Capture readbacks never settle here; only the encoding is checked.
      mapAsync: vi.fn(() => new Promise<void>(() => {})),
    })),
    createBindGroupLayout: vi.fn((descriptor: GPUBindGroupLayoutDescriptor) => ({
      label: descriptor.label,
    })),
    createPipelineLayout: vi.fn(() => ({})),
    createBindGroup: vi.fn((descriptor: GPUBindGroupDescriptor) => ({ label: descriptor.label })),
    createShaderModule: vi.fn(() => ({})),
    createRenderPipelineAsync: vi.fn((descriptor: GPURenderPipelineDescriptor) => {
      const label = descriptor.label ?? '';
      if (options.failLabel !== undefined && label.includes(options.failLabel)) {
        return Promise.reject(new Error('injected pipeline failure'));
      }
      descriptors.push(descriptor);
      return Promise.resolve({ label });
    }),
    createTexture: vi.fn((descriptor: GPUTextureDescriptor) => {
      if (options.failTexture !== undefined && descriptor.label === options.failTexture) {
        throw new Error('injected texture failure');
      }
      const record = {
        label: descriptor.label ?? '',
        format: String(descriptor.format),
        sampleCount: descriptor.sampleCount ?? 1,
        destroyed: false,
      };
      textures.push(record);
      return {
        label: record.label,
        createView: vi.fn(() => ({ texture: record.label })),
        destroy: vi.fn(() => {
          record.destroyed = true;
        }),
      };
    }),
    createCommandEncoder: vi.fn(() => ({
      beginRenderPass: vi.fn((descriptor: GPURenderPassDescriptor) => {
        const record: PassRecord = { descriptor, calls: [] };
        passes.push(record);
        const log =
          (name: string) =>
          (...args: unknown[]) =>
            record.calls.push([name, ...args]);
        return {
          setPipeline: (pipeline: { label: string }) =>
            record.calls.push(['setPipeline', pipeline.label]),
          setBindGroup: log('setBindGroup'),
          setVertexBuffer: log('setVertexBuffer'),
          setIndexBuffer: log('setIndexBuffer'),
          setStencilReference: log('setStencilReference'),
          drawIndexed: log('drawIndexed'),
          draw: log('draw'),
          end: log('end'),
        };
      }),
      copyTextureToBuffer: vi.fn(),
      finish: vi.fn(() => ({})),
    })),
    queue: {
      writeBuffer: vi.fn(),
      submit: vi.fn(),
      onSubmittedWorkDone: vi.fn(() => new Promise<void>(() => {})),
    },
  } as unknown as GPUDevice;
  const context = {
    native: { getCurrentTexture: () => ({ createView: () => ({ texture: 'presentation' }) }) },
    configure: vi.fn(),
    unconfigure: vi.fn(),
  } as unknown as WebGpuCanvasContextPort;
  return { device, context, passes, descriptors, textures };
}

async function scene(
  f: ReturnType<typeof fixture>,
  options: Readonly<{ meshPipeline?: boolean; countPass?: boolean; sampleCount?: 1 | 4 }>,
) {
  const accounting = new ResourceAccounting();
  const creation = createNativePrimitiveSceneCreation(
    f.device,
    f.context,
    'bgra8unorm',
    1,
    accounting,
    options,
  );
  const { scene } = await creation.result;
  const target = (surfaceRevision: number, width = 64, height = 32): PrimitiveTarget => ({
    generation: 1,
    surfaceRevision,
    width,
    height,
    devicePixelRatio: 1,
    sampleCount: scene.sampleCount,
    targetFormat: 'bgra8unorm',
  });
  return { scene, creation, accounting, target };
}

const liveStencil = (f: ReturnType<typeof fixture>) =>
  f.textures.filter((t) => t.format === 'stencil8' && !t.destroyed).map((t) => t.label);

describe('E17-A1 pipeline descriptors and keys', () => {
  const module = {} as GPUShaderModule;
  const layout = {} as GPUPipelineLayout;

  it('E17-A1: mesh pipelines write once; the analytic pipeline of a mesh generation keeps the stencil', () => {
    for (const kind of ['fill', 'joint'] as const) {
      const descriptor = createMeshPipelineDescriptor(module, layout, 'bgra8unorm', 4, kind);
      expect(descriptor.depthStencil).toEqual(meshWriteOnceStencilState());
      expect(meshPipelineKey('bgra8unorm', 4, kind).renderStateKey).toBe(MESH_RENDER_STATE_KEY);
    }
    expect(meshWriteOnceStencilState()).toEqual({
      format: 'stencil8',
      depthWriteEnabled: false,
      depthCompare: 'always',
      stencilFront: {
        compare: 'not-equal',
        failOp: 'keep',
        depthFailOp: 'keep',
        passOp: 'replace',
      },
      stencilBack: { compare: 'not-equal', failOp: 'keep', depthFailOp: 'keep', passOp: 'replace' },
      stencilReadMask: 0xff,
      stencilWriteMask: 0xff,
    });
    const analytic = createPrimitivePipelineDescriptor(module, layout, 'bgra8unorm', 4, true);
    expect(analytic.depthStencil).toMatchObject({
      format: 'stencil8',
      stencilFront: { compare: 'always', passOp: 'keep' },
      stencilWriteMask: 0,
    });
    expect(primitivePipelineKey('bgra8unorm', 4, true).renderStateKey).toBe(
      PRIMITIVE_STENCIL_RENDER_STATE_KEY,
    );
    const reset = createMeshStencilResetPipelineDescriptor(module, 'bgra8unorm', 4, 'reset');
    expect(reset.depthStencil).toMatchObject({
      format: 'stencil8',
      stencilFront: { compare: 'always', passOp: 'zero' },
      stencilWriteMask: 0xff,
    });
    expect(reset.fragment!.targets).toEqual([{ format: 'bgra8unorm', writeMask: 0 }]);
  });

  it('E17-A1: a generation without the mesh option keeps P1 pipeline, key and pass unchanged', async () => {
    const plain = createPrimitivePipelineDescriptor(module, layout, 'bgra8unorm', 4);
    expect(plain.depthStencil).toBeUndefined();
    expect(primitivePipelineKey('bgra8unorm', 4).renderStateKey).toBe(PRIMITIVE_RENDER_STATE_KEY);
    const f = fixture();
    const { scene: s, creation, target } = await scene(f, {});
    s.setTarget(target(1));
    expect(f.descriptors.map((d) => d.label)).toEqual(['vector-studio/p1-analytic-primitive-4x']);
    expect(liveStencil(f)).toEqual([]);
    creation.dispose();
  });

  it('E17-A1: count pipelines replay the write-once state; the count reset targets rgba16float', async () => {
    const f = fixture();
    const { creation } = await scene(f, { meshPipeline: true, countPass: true });
    const byLabel = new Map(f.descriptors.map((d) => [d.label, d]));
    for (const kind of ['fill', 'joint']) {
      expect(byLabel.get(`vector-studio/e10-count-${kind}-4x`)!.depthStencil).toEqual(
        meshWriteOnceStencilState(),
      );
    }
    const reset = byLabel.get('vector-studio/e10-count-stencil-reset-4x')!;
    expect(reset.fragment!.targets).toEqual([{ format: 'rgba16float', writeMask: 0 }]);
    expect(byLabel.get('vector-studio/p1-analytic-primitive-stencil-4x')).toBeDefined();
    expect(byLabel.get('vector-studio/p3-mesh-stencil-reset-4x')).toBeDefined();
    creation.dispose();
  });
});

describe('E17-A2 encoding', () => {
  it('E17-A2: references follow (k mod 255) + 1 with a reset before ordinals 255 and 510', () => {
    expect(MESH_STENCIL_REFERENCES).toBe(255);
    const steps = Array.from({ length: 600 }, (_, k) => meshStencilStep(k));
    expect(steps.flatMap((step, k) => (step.reset ? [k] : []))).toEqual([255, 510]);
    expect(steps.map((step) => step.reference).slice(253, 258)).toEqual([254, 255, 1, 2, 3]);
    expect(steps[599]!.reference).toBe(90);
  });

  it('E17-A2: a 600-draw frame sets each reference, resets twice, and the count pass replays it', async () => {
    const f = fixture();
    const { scene: s, creation, target } = await scene(f, { meshPipeline: true, countPass: true });
    const t = target(1);
    s.setTarget(t);
    // Distinct small triangles inside the 64 x 32 target, so none is culled.
    const nodes = Array.from({ length: 600 }, (_, i) => pathNode(`p${i}`, (i % 50) + i / 1024));
    const h = createPathHarness({ port: createCountingPort(), nodes });
    const packet = h.source.prepare(t)!;
    expect(packet.mesh!.draws).toHaveLength(600);
    const settled = new Promise<void>((resolve) => {
      s.captureNextSubmissionForTesting!({
        counts: true,
        encoded: () => resolve(),
        resolve: () => undefined,
        reject: () => undefined,
      });
    });
    expect(s.submitPrimitivePacket(packet).status).toBe('submitted');
    await settled;

    const [main, count] = f.passes;
    expect(main!.descriptor.depthStencilAttachment).toEqual({
      view: { texture: 'primitive/1/stencil-1' },
      stencilClearValue: 0,
      stencilLoadOp: 'clear',
      stencilStoreOp: 'discard',
    });
    expect(count!.descriptor.label).toBe('vector-studio/e10-count-pass');
    expect(count!.descriptor.depthStencilAttachment).toMatchObject({
      stencilLoadOp: 'clear',
      stencilStoreOp: 'discard',
    });
    expect(
      (count!.descriptor.depthStencilAttachment as unknown as { view: { texture: string } }).view
        .texture,
    ).toMatch(/count-stencil$/u);
    expect(f.textures.find((t) => t.label.endsWith('count-stencil'))!.sampleCount).toBe(4);

    const sequence = (pass: PassRecord, reset: string) =>
      pass.calls.flatMap((call): (number | 'reset')[] => {
        if (call[0] === 'setStencilReference') return [call[1] as number];
        if (call[0] === 'setPipeline' && call[1] === reset) return ['reset'];
        return [];
      });
    const expected = Array.from({ length: 600 }, (_, k) => {
      const step = meshStencilStep(k);
      return step.reset ? ['reset', step.reference] : [step.reference];
    }).flat();
    expect(sequence(main!, 'vector-studio/p3-mesh-stencil-reset-4x')).toEqual(expected);
    expect(sequence(count!, 'vector-studio/e10-count-stencil-reset-4x')).toEqual(expected);
    // Each reset is a fullscreen triangle, and every mesh draw follows its own reference.
    for (const pass of [main!, count!]) {
      const resets = pass.calls.flatMap((call, index) =>
        call[0] === 'setPipeline' && String(call[1]).includes('stencil-reset') ? [index] : [],
      );
      expect(resets).toHaveLength(2);
      for (const index of resets) expect(pass.calls[index + 1]).toEqual(['draw', 3]);
      pass.calls.forEach((call, index) => {
        if (call[0] === 'draw' && call.length === 5)
          expect(pass.calls[index - 1]![0]).toBe('setStencilReference');
      });
    }
    creation.dispose();
  });
});

describe('E17-A3 attachment lifetime', () => {
  for (const sampleCount of [1, 4] as const) {
    it(`E17-A3: the ${sampleCount}x stencil attachment follows the target and is released`, async () => {
      const f = fixture();
      const {
        scene: s,
        creation,
        accounting,
        target,
      } = await scene(f, {
        meshPipeline: true,
        sampleCount,
      });
      const textures = () => accounting.snapshot().byCategory.texture.live;
      s.setTarget(target(1));
      expect(liveStencil(f)).toEqual(['primitive/1/stencil-1']);
      expect(f.textures.find((t) => t.format === 'stencil8')!.sampleCount).toBe(sampleCount);
      expect(textures()).toBe(sampleCount === 4 ? 2 : 1);
      s.setTarget(target(2, 128, 64));
      expect(liveStencil(f)).toEqual(['primitive/1/stencil-2']);
      expect(textures()).toBe(sampleCount === 4 ? 2 : 1);
      s.setTarget(target(3, 0, 0));
      expect(liveStencil(f)).toEqual([]);
      expect(textures()).toBe(0);
      s.setTarget(target(4));
      expect(liveStencil(f)).toEqual(['primitive/1/stencil-4']);
      creation.dispose();
      expect(liveStencil(f)).toEqual([]);
      expect(accounting.snapshot().live).toBe(0);
    });
  }

  it('E17-A3: a failed 4x resize keeps the previous stencil and colour attachments together', async () => {
    const f = fixture({ failTexture: 'primitive/1/attachment-2' });
    const { scene: s, creation, accounting, target } = await scene(f, { meshPipeline: true });
    s.setTarget(target(1));
    expect(() => s.setTarget(target(2, 128, 64))).toThrow();
    expect(liveStencil(f)).toEqual(['primitive/1/stencil-1']);
    expect(accounting.snapshot().byCategory.texture.live).toBe(2);
    creation.dispose();
    expect(accounting.snapshot().live).toBe(0);
  });

  it('E17-A3: a failed reset pipeline leaves the mesh path unavailable with no mesh object tracked', async () => {
    const f = fixture({ failLabel: 'p3-mesh-stencil-reset' });
    const { scene: s, creation, accounting, target } = await scene(f, { meshPipeline: true });
    expect(s).toMatchObject({ meshPipelineAvailable: false, pipelinesCreated: 1 });
    expect(accounting.snapshot().byCategory['render-pipeline'].live).toBe(1);
    expect(accounting.snapshot().byCategory['shader-module'].live).toBe(1);
    // The pass still carries the stencil attachment its analytic pipeline declares.
    s.setTarget(target(1));
    expect(liveStencil(f)).toEqual(['primitive/1/stencil-1']);
    creation.dispose();
    expect(accounting.snapshot().live).toBe(0);
  });
});
