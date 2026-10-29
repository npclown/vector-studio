import {
  ResourceAccounting,
  type PrimitiveSubmitResult,
  type PrimitiveTarget,
} from '@vector-studio/renderer-core';
import { vi } from 'vitest';

import { createNativePrimitiveSceneCreation } from '../../packages/renderer-webgpu/src/native-primitive-scene.js';
import type { WebGpuCanvasContextPort } from '../../packages/renderer-webgpu/src/webgpu-platform.js';

// P4 contract (docs/plans/p4-clip-mask.md), units U3 and U4: a fake device for the native
// primitive scene that records the pass, pipeline, bind group and draw calls, the buffer writes
// and the textures created and destroyed. No GPU work runs.

export type Call = readonly [string, ...unknown[]];

export function nativeFixture(options: Readonly<{ failPipeline?: string }> = {}) {
  const calls: Call[] = [];
  const pipelineLabels: string[] = [];
  const descriptors: GPURenderPipelineDescriptor[] = [];
  const modules: string[] = [];
  const writes: { label: string; offset: number; bytes: number }[] = [];
  const textures: {
    label: string;
    format: GPUTextureFormat;
    sampleCount: number;
    width: number;
    height: number;
    usage: number;
  }[] = [];
  const destroyed: string[] = [];
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
      maxTextureDimension2D: 8192,
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
    createTexture: vi.fn((descriptor: GPUTextureDescriptor) => {
      const label = descriptor.label ?? '';
      const { width, height } = descriptor.size as GPUExtent3DDict;
      textures.push({
        label,
        format: descriptor.format,
        sampleCount: descriptor.sampleCount ?? 1,
        width,
        height: height ?? 1,
        usage: descriptor.usage,
      });
      return {
        label,
        createView: vi.fn(() => ({ texture: label })),
        destroy: vi.fn(() => destroyed.push(label)),
      };
    }),
    createCommandEncoder: vi.fn(() => ({
      beginRenderPass: vi.fn((descriptor: GPURenderPassDescriptor) => {
        const [color] = [...descriptor.colorAttachments];
        const view = (attachment: unknown) =>
          (attachment as { texture?: string } | undefined)?.texture ?? null;
        calls.push([
          'beginRenderPass',
          descriptor.label,
          view(color?.view),
          view(color?.resolveTarget),
          view(descriptor.depthStencilAttachment?.view),
        ]);
        return {
          setViewport: (...args: number[]) => calls.push(['setViewport', ...args]),
          setPipeline: (pipeline: { label: string }) => calls.push(['setPipeline', pipeline.label]),
          setBindGroup: (index: number, group: { label: string }, offsets?: number[]) =>
            calls.push(['setBindGroup', index, group.label, ...(offsets ?? [])]),
          setVertexBuffer: () => calls.push(['setVertexBuffer']),
          setIndexBuffer: () => calls.push(['setIndexBuffer']),
          drawIndexed: (...args: number[]) => calls.push(['drawIndexed', ...args]),
          draw: (...args: number[]) => calls.push(['draw', ...args]),
          setStencilReference: (reference: number) =>
            calls.push(['setStencilReference', reference]),
          end: () => calls.push(['end']),
        };
      }),
      copyTextureToTexture: vi.fn(
        (
          source: { texture: { label: string } },
          destination: { texture: { label: string }; origin: { x: number; y: number } },
          size: { width: number; height: number },
        ) =>
          calls.push([
            'copyTextureToTexture',
            source.texture.label,
            destination.texture.label,
            destination.origin.x,
            destination.origin.y,
            size.width,
            size.height,
          ]),
      ),
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
  return {
    device,
    context,
    calls,
    pipelineLabels,
    descriptors,
    modules,
    writes,
    textures,
    destroyed,
  };
}

export async function nativeScene(
  fixture: ReturnType<typeof nativeFixture>,
  options: Readonly<{ meshPipeline?: boolean; clipPipeline?: boolean; paintPipeline?: boolean }> = {
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

export function submitted(result: PrimitiveSubmitResult) {
  if (result.status !== 'submitted') throw new Error(`not submitted: ${JSON.stringify(result)}`);
  return result.receipt;
}
