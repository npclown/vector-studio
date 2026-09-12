import type { RenderNodeSnapshot } from '@vector-studio/contracts';
import {
  PrimitiveSceneSource,
  PrimitiveRendererService,
  ResourceAccounting,
  RetainedSceneMirror,
  type PrimitiveTarget,
} from '@vector-studio/renderer-core';
import { describe, expect, it, vi } from 'vitest';

import { createNativePrimitiveSceneCreation } from '../../packages/renderer-webgpu/src/native-primitive-scene.js';
import type { WebGpuCanvasContextPort } from '../../packages/renderer-webgpu/src/webgpu-platform.js';

const identity = { documentId: 'native-integration', pageId: 'page' };

function rectangle(id: string, x: number): RenderNodeSnapshot {
  return {
    id,
    parentId: null,
    kind: 'primitive',
    visible: true,
    opacity: 1,
    transform: [1, 0, 0, 1, x, 0],
    geometry: { kind: 'rectangle', width: 10, height: 10, cornerRadii: [0, 0, 0, 0] },
    style: { fill: { r: 1, g: 1, b: 1, a: 1 }, stroke: null },
  };
}

function benchmarkPrimitive(index: number, center?: { x: number; y: number }): RenderNodeSnapshot {
  const x = center?.x ?? 10 + 20 * (index % 100);
  const y = center?.y ?? 10 + 20 * Math.floor(index / 100);
  const word = (Math.imul(1664525, (0x50310001 ^ index) >>> 0) + 1013904223) >>> 0;
  const channel = (byte: number) => ((word >>> (8 * byte)) & 255) / 255;
  const fill = {
    r: 0.2 + 0.6 * channel(0),
    g: 0.2 + 0.6 * channel(1),
    b: 0.2 + 0.6 * channel(2),
    a: 0.45 + 0.4 * channel(3),
  };
  const stroke = {
    color: {
      r: 0.8 - 0.6 * channel(2),
      g: 0.8 - 0.6 * channel(1),
      b: 0.8 - 0.6 * channel(0),
      a: 0.65,
    },
    width: index % 4 === 3 ? 1 : 0.5,
  };
  const common = {
    id: `p1-${String(index).padStart(5, '0')}`,
    parentId: null,
    kind: 'primitive' as const,
    visible: true,
    opacity: 0.5 + 0.25 * (index % 3),
  };
  switch (index % 4) {
    case 0:
      return {
        ...common,
        transform: [1, 0, 0, 1, x - 1.5, y - 1],
        geometry: { kind: 'rectangle', width: 3, height: 2, cornerRadii: [0, 0, 0, 0] },
        style: { fill, stroke },
      };
    case 1:
      return {
        ...common,
        transform: [1, 0, 0, 1, x - 1.5, y - 1.5],
        geometry: { kind: 'rectangle', width: 3, height: 3, cornerRadii: [0.5, 1, 0.5, 1] },
        style: { fill, stroke },
      };
    case 2:
      return {
        ...common,
        transform: [1, 0, 0, 1, x - 1.5, y - 1],
        geometry: { kind: 'ellipse', width: 3, height: 2 },
        style: { fill, stroke },
      };
    default:
      return {
        ...common,
        transform: [1, 0, 0, 1, x, y],
        geometry: {
          kind: 'line',
          start: { x: -1.75, y: 0 },
          end: { x: 1.75, y: 0 },
        },
        style: { fill: null, stroke },
      };
  }
}

function nativeFixture() {
  const writes: Array<readonly [number, number]> = [];
  const writeBuffer = vi.fn(
    (
      _buffer: GPUBuffer,
      byteOffset: number,
      _data: AllowSharedBufferSource,
      _dataOffset?: number,
      size?: number,
    ) => {
      writes.push([byteOffset, size ?? 0]);
    },
  );
  const submit = vi.fn();
  const draws: Array<readonly [number, number, number, number, number]> = [];
  const drawIndexed = vi.fn(
    (
      indexCount: number,
      instanceCount: number,
      firstIndex: number,
      baseVertex: number,
      firstInstance: number,
    ) => {
      draws.push([indexCount, instanceCount, firstIndex, baseVertex, firstInstance]);
    },
  );
  const bindingRanges: Array<readonly [number, number]> = [];
  const createBindGroup = vi.fn((descriptor: GPUBindGroupDescriptor) => {
    for (const entry of descriptor.entries) {
      const resource = entry.resource as GPUBufferBinding;
      bindingRanges.push([resource.offset ?? 0, Number(resource.size)]);
    }
    return {} as GPUBindGroup;
  });
  let bufferCreations = 0;
  const completion = new Promise<void>(() => undefined);
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
    createBuffer: vi.fn(() => {
      bufferCreations += 1;
      return { destroy: vi.fn() };
    }),
    createBindGroupLayout: vi.fn(() => ({})),
    createPipelineLayout: vi.fn(() => ({})),
    createBindGroup,
    createShaderModule: vi.fn(() => ({})),
    createRenderPipelineAsync: vi.fn(() => Promise.resolve({})),
    createTexture: vi.fn(() => ({ createView: vi.fn(() => ({})), destroy: vi.fn() })),
    createCommandEncoder: vi.fn(() => ({
      beginRenderPass: vi.fn(() => ({
        setPipeline: vi.fn(),
        setBindGroup: vi.fn(),
        setVertexBuffer: vi.fn(),
        setIndexBuffer: vi.fn(),
        drawIndexed,
        end: vi.fn(),
      })),
      finish: vi.fn(() => ({})),
    })),
    queue: { writeBuffer, submit, onSubmittedWorkDone: vi.fn(() => completion) },
  } as unknown as GPUDevice;
  const context = {
    native: { getCurrentTexture: () => ({ createView: () => ({}) }) },
    configure: vi.fn(),
    unconfigure: vi.fn(),
  } as unknown as WebGpuCanvasContextPort;
  return {
    device,
    context,
    writeBuffer,
    submit,
    writes,
    draws,
    bindingRanges,
    get bufferCreations() {
      return bufferCreations;
    },
  };
}

describe('native primitive packet integration', () => {
  it('composes the D1 service with scene and viewport invalidation on one frame source', () => {
    const invalidate = vi.fn();
    const service = new PrimitiveRendererService({ invalidate, setMode: vi.fn() });
    expect(
      service.replaceSnapshot({
        identity,
        revision: 0,
        nodes: [rectangle('a', 0)],
        rootOrder: ['a'],
      }).status,
    ).toBe('applied');
    expect(invalidate).toHaveBeenLastCalledWith({ reason: 'scene' });
    service.setCamera({ position: { x: 0, y: 0 }, zoom: 1 });
    expect(invalidate).toHaveBeenCalledTimes(1);
    service.setCamera({ position: { x: 1, y: 0 }, zoom: 1 });
    expect(invalidate).toHaveBeenLastCalledWith({ reason: 'viewport' });
    expect(
      service.prepare({
        generation: 1,
        surfaceRevision: 1,
        width: 640,
        height: 360,
        devicePixelRatio: 1,
        sampleCount: 4,
        targetFormat: 'bgra8unorm',
      }),
    ).not.toBeNull();
    service.dispose();
    service.dispose();
    expect(service.getSynchronizationState()).toEqual({ status: 'disposed', current: null });
    expect(
      service.prepare({
        generation: 1,
        surfaceRevision: 1,
        width: 640,
        height: 360,
        devicePixelRatio: 1,
        sampleCount: 4,
        targetFormat: 'bgra8unorm',
      }),
    ).toBeNull();
  });

  it('maps B01 logical writes to the five aligned arena regions without moving payload slots', async () => {
    const native = nativeFixture();
    const accounting = new ResourceAccounting();
    const creation = createNativePrimitiveSceneCreation(
      native.device,
      native.context,
      'bgra8unorm',
      1,
      accounting,
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
    const mirror = new RetainedSceneMirror();
    mirror.replaceSnapshot({
      identity,
      revision: 0,
      nodes: [rectangle('b', 20), rectangle('a', 0)],
      rootOrder: ['a', 'b'],
    });
    const source = new PrimitiveSceneSource(mirror);
    native.writeBuffer.mockClear();
    native.writes.length = 0;

    const initial = source.prepare(target)!;
    const submitted = scene.submitPrimitivePacket(initial);
    expect(submitted.status).toBe('submitted');
    expect(native.writes).toEqual([
      [0, 64],
      [512, 96],
      [1280, 96],
      [2048, 8],
      [2304, 32],
    ]);
    expect(native.bindingRanges).toEqual([
      [0, 512],
      [512, 768],
      [1280, 768],
      [2048, 64],
      [2304, 32],
    ]);
    if (submitted.status === 'submitted') source.acknowledge(submitted.receipt);

    mirror.applyChanges({
      identity,
      baseRevision: 0,
      revision: 1,
      inserted: [],
      updated: [],
      removed: [],
      orders: [{ parentId: null, children: ['b', 'a'] }],
    });
    native.writeBuffer.mockClear();
    native.writes.length = 0;
    const reordered = source.prepare(target)!;
    const reorderedResult = scene.submitPrimitivePacket(reordered);
    expect(native.writes).toEqual([[2048, 8]]);
    if (reorderedResult.status === 'submitted') source.acknowledge(reorderedResult.receipt);

    mirror.applyChanges({
      identity,
      baseRevision: 1,
      revision: 2,
      inserted: [],
      updated: [rectangle('a', 0.5)],
      removed: [],
      orders: [],
    });
    native.writeBuffer.mockClear();
    native.writes.length = 0;
    const moved = source.prepare(target)!;
    expect(scene.submitPrimitivePacket(moved).status).toBe('submitted');
    expect(native.writes).toEqual([[0, 32]]);
    creation.dispose();
    expect(accounting.snapshot().live).toBe(0);
  });

  it('keeps revision-token dirtiness through stale acknowledgment and rebuilds latest state', async () => {
    const firstNative = nativeFixture();
    const firstAccounting = new ResourceAccounting();
    const firstCreation = createNativePrimitiveSceneCreation(
      firstNative.device,
      firstNative.context,
      'bgra8unorm',
      1,
      firstAccounting,
    );
    const firstScene = (await firstCreation.result).scene;
    const firstTarget: PrimitiveTarget = {
      generation: 1,
      surfaceRevision: 1,
      width: 640,
      height: 360,
      devicePixelRatio: 1,
      sampleCount: firstScene.sampleCount,
      targetFormat: 'bgra8unorm',
    };
    firstScene.setTarget(firstTarget);
    const mirror = new RetainedSceneMirror();
    mirror.replaceSnapshot({ identity, revision: 4, nodes: [rectangle('a', 0)], rootOrder: ['a'] });
    const source = new PrimitiveSceneSource(mirror);
    const revision4 = source.prepare(firstTarget)!;
    const submitted4 = firstScene.submitPrimitivePacket(revision4);
    expect(submitted4.status).toBe('submitted');

    mirror.applyChanges({
      identity,
      baseRevision: 4,
      revision: 5,
      inserted: [],
      updated: [rectangle('a', 1)],
      removed: [],
      orders: [],
    });
    const revision5 = source.prepare(firstTarget)!;
    expect(revision5.scene.revision).toBe(5);
    if (submitted4.status === 'submitted') source.acknowledge(submitted4.receipt);
    const pending5 = source.prepare(firstTarget)!;
    expect(pending5.scene.revision).toBe(5);
    expect(pending5.writes.some((write) => write.resourceId === 'transforms')).toBe(true);
    const submitted5 = firstScene.submitPrimitivePacket(pending5);
    expect(submitted5.status).toBe('submitted');
    if (submitted5.status === 'submitted') source.acknowledge(submitted5.receipt);
    expect(source.prepare(firstTarget)!.writes).toEqual([]);

    firstCreation.dispose();
    mirror.applyChanges({
      identity,
      baseRevision: 5,
      revision: 6,
      inserted: [],
      updated: [rectangle('a', 2)],
      removed: [],
      orders: [],
    });
    const recoveredNative = nativeFixture();
    const recoveredAccounting = new ResourceAccounting();
    const recoveredCreation = createNativePrimitiveSceneCreation(
      recoveredNative.device,
      recoveredNative.context,
      'bgra8unorm',
      2,
      recoveredAccounting,
    );
    const recoveredScene = (await recoveredCreation.result).scene;
    const recoveredTarget = {
      ...firstTarget,
      generation: 2,
      sampleCount: recoveredScene.sampleCount,
    };
    recoveredScene.setTarget(recoveredTarget);
    const rebuilt = source.prepare(recoveredTarget)!;
    expect(rebuilt).toMatchObject({ mode: 'reconstruct', scene: { revision: 6 }, generation: 2 });
    expect(recoveredScene.submitPrimitivePacket(rebuilt).status).toBe('submitted');
    expect(recoveredNative.writes.slice(2).map(([offset]) => offset)).toEqual([
      0, 512, 1280, 2048, 2304,
    ]);
    recoveredCreation.dispose();
    expect(firstAccounting.snapshot().live).toBe(0);
    expect(recoveredAccounting.snapshot().live).toBe(0);
  });

  it('preserves N04 as one native 32-byte transform write after warmup', async () => {
    const native = nativeFixture();
    const accounting = new ResourceAccounting();
    const creation = createNativePrimitiveSceneCreation(
      native.device,
      native.context,
      'bgra8unorm',
      1,
      accounting,
    );
    const { scene } = await creation.result;
    const target: PrimitiveTarget = {
      generation: 1,
      surfaceRevision: 1,
      width: 1280,
      height: 720,
      devicePixelRatio: 1,
      sampleCount: scene.sampleCount,
      targetFormat: 'bgra8unorm',
    };
    scene.setTarget(target);
    const nodes = Array.from({ length: 10_000 }, (_, index) => benchmarkPrimitive(index));
    const mirror = new RetainedSceneMirror();
    mirror.replaceSnapshot({ identity, revision: 0, nodes, rootOrder: nodes.map(({ id }) => id) });
    mirror.setCamera({ position: { x: 0, y: 0 }, zoom: 1.5 });
    const source = new PrimitiveSceneSource(mirror);
    const initial = source.prepare(target)!;
    const submitted = scene.submitPrimitivePacket(initial);
    if (submitted.status === 'submitted') source.acknowledge(submitted.receipt);
    mirror.applyChanges({
      identity,
      baseRevision: 0,
      revision: 1,
      inserted: [],
      updated: [benchmarkPrimitive(0, { x: 14, y: 6 })],
      removed: [],
      orders: [],
    });
    native.writeBuffer.mockClear();
    native.writes.length = 0;
    const moved = source.prepare(target)!;
    expect(scene.submitPrimitivePacket(moved).status).toBe('submitted');
    expect(native.draws.at(-1)).toEqual([6, 1032, 0, 0, 0]);
    expect(native.writes).toEqual([[0, 32]]);
    creation.dispose();
  });

  it('reuses a removed logical slot through ordered queue writes without replacing its arena', async () => {
    const native = nativeFixture();
    const accounting = new ResourceAccounting();
    const creation = createNativePrimitiveSceneCreation(
      native.device,
      native.context,
      'bgra8unorm',
      1,
      accounting,
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
    const mirror = new RetainedSceneMirror();
    mirror.replaceSnapshot({ identity, revision: 0, nodes: [rectangle('a', 0)], rootOrder: ['a'] });
    const source = new PrimitiveSceneSource(mirror);
    let result = scene.submitPrimitivePacket(source.prepare(target)!);
    if (result.status === 'submitted') source.acknowledge(result.receipt);
    mirror.applyChanges({
      identity,
      baseRevision: 0,
      revision: 1,
      inserted: [],
      updated: [],
      removed: ['a'],
      orders: [{ parentId: null, children: [] }],
    });
    result = scene.submitPrimitivePacket(source.prepare(target)!);
    if (result.status === 'submitted') source.acknowledge(result.receipt);
    mirror.applyChanges({
      identity,
      baseRevision: 1,
      revision: 2,
      inserted: [rectangle('b', 20)],
      updated: [],
      removed: [],
      orders: [{ parentId: null, children: ['b'] }],
    });
    native.writeBuffer.mockClear();
    native.writes.length = 0;
    const inserted = source.prepare(target)!;
    expect(scene.submitPrimitivePacket(inserted).status).toBe('submitted');
    expect(native.writes).toEqual([
      [0, 32],
      [512, 48],
      [1280, 48],
      [2048, 4],
    ]);
    expect(native.bufferCreations).toBe(3);
    creation.dispose();
  });

  it('releases a partially uploaded growth arena and retries the full reconstruction', async () => {
    const native = nativeFixture();
    const accounting = new ResourceAccounting();
    const creation = createNativePrimitiveSceneCreation(
      native.device,
      native.context,
      'bgra8unorm',
      1,
      accounting,
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
    const mirror = new RetainedSceneMirror();
    mirror.replaceSnapshot({ identity, revision: 0, nodes: [rectangle('a', 0)], rootOrder: ['a'] });
    const source = new PrimitiveSceneSource(mirror);
    const initial = scene.submitPrimitivePacket(source.prepare(target)!);
    if (initial.status === 'submitted') source.acknowledge(initial.receipt);
    const nodes = Array.from({ length: 17 }, (_, index) => rectangle(`n${index}`, index * 12));
    mirror.replaceSnapshot({ identity, revision: 1, nodes, rootOrder: nodes.map(({ id }) => id) });
    native.writeBuffer.mockClear();
    native.writeBuffer
      .mockImplementationOnce((_buffer, byteOffset, _data, _dataOffset, size) => {
        native.writes.push([byteOffset, size ?? 0]);
      })
      .mockImplementationOnce(() => {
        throw new Error('injected second growth write failure');
      });
    expect(scene.submitPrimitivePacket(source.prepare(target)!)).toEqual({
      status: 'failed',
      reason: 'submission-failed',
    });
    expect(native.writeBuffer).toHaveBeenCalledTimes(2);
    expect(native.submit).toHaveBeenCalledTimes(1);
    expect(native.writes.at(-1)).toEqual([0, 17 * 32]);
    expect(accounting.snapshot().byCategory.buffer.liveBytes).toBe(4096 + 44);
    native.writeBuffer.mockImplementation(
      (
        _buffer: GPUBuffer,
        byteOffset: number,
        _data: AllowSharedBufferSource,
        _dataOffset?: number,
        size?: number,
      ) => {
        native.writes.push([byteOffset, size ?? 0]);
      },
    );
    const retry = source.prepare(target)!;
    expect(retry.mode).toBe('reconstruct');
    expect(scene.submitPrimitivePacket(retry).status).toBe('submitted');
    expect(accounting.snapshot().byCategory.buffer.liveBytes).toBe(4096 + 8192 + 44);
    creation.dispose();
    expect(accounting.snapshot().live).toBe(0);
  });

  it('maps the N03 hysteresis rebase to exactly one native transform record', async () => {
    const native = nativeFixture();
    const accounting = new ResourceAccounting();
    const creation = createNativePrimitiveSceneCreation(
      native.device,
      native.context,
      'bgra8unorm',
      1,
      accounting,
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
    const wide = {
      ...rectangle('a', -1000),
      geometry: {
        kind: 'rectangle' as const,
        width: 2200,
        height: 10,
        cornerRadii: [0, 0, 0, 0] as const,
      },
    };
    const mirror = new RetainedSceneMirror();
    mirror.replaceSnapshot({ identity, revision: 0, nodes: [wide], rootOrder: ['a'] });
    const source = new PrimitiveSceneSource(mirror);
    const initial = scene.submitPrimitivePacket(source.prepare(target)!);
    if (initial.status === 'submitted') source.acknowledge(initial.receipt);
    const transformWrites: number[] = [];
    for (const x of [255.75, 256, 511.75, 512, 512.25, 511.75]) {
      mirror.setCamera({ position: { x, y: 0 }, zoom: 1 });
      native.writeBuffer.mockClear();
      native.writes.length = 0;
      const packet = source.prepare(target)!;
      const result = scene.submitPrimitivePacket(packet);
      transformWrites.push(
        native.writes.filter(([offset, size]) => offset === 0 && size === 32).length,
      );
      if (result.status === 'submitted') source.acknowledge(result.receipt);
    }
    expect(transformWrites).toEqual([0, 0, 0, 0, 1, 0]);
    creation.dispose();
  });
});
