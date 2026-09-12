import type { RenderNodeSnapshot } from '@vector-studio/contracts';
import {
  PrimitiveSceneSource,
  ResourceAccounting,
  RetainedSceneMirror,
  type PrimitivePacket,
  type PrimitiveTarget,
} from '@vector-studio/renderer-core';
import { describe, expect, it, vi } from 'vitest';
import { createNativePrimitiveSceneCreation } from '../../packages/renderer-webgpu/src/native-primitive-scene.js';
import type { WebGpuCanvasContextPort } from '../../packages/renderer-webgpu/src/webgpu-platform.js';

function deferred() {
  let resolve!: () => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function nativeFixture() {
  const buffers: Array<{ size: number; usage: number; destroy: ReturnType<typeof vi.fn> }> = [];
  const completions: ReturnType<typeof deferred>[] = [];
  const writeBuffer = vi.fn(
    (
      buffer: { size: number },
      offset: number,
      data: ArrayBufferView,
      dataOffset = 0,
      size?: number,
    ) => {
      const elementSize = 'BYTES_PER_ELEMENT' in data ? Number(data.BYTES_PER_ELEMENT) : 1;
      const byteCount =
        size === undefined ? data.byteLength - dataOffset * elementSize : size * elementSize;
      if (
        dataOffset * elementSize + byteCount > data.byteLength ||
        offset + byteCount > buffer.size
      ) {
        throw new RangeError('Native writeBuffer source or destination bounds exceeded');
      }
    },
  );
  const submit = vi.fn();
  const drawIndexed = vi.fn();
  const createBindGroup = vi.fn(() => ({}));
  const createRenderPipelineAsync = vi.fn(() => Promise.resolve({}));
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
    createBuffer: vi.fn((descriptor: GPUBufferDescriptor) => {
      const buffer = { size: descriptor.size, usage: descriptor.usage, destroy: vi.fn() };
      buffers.push(buffer);
      return buffer;
    }),
    createBindGroupLayout: vi.fn(() => ({})),
    createPipelineLayout: vi.fn(() => ({})),
    createBindGroup,
    createShaderModule: vi.fn(() => ({})),
    createRenderPipelineAsync,
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
    queue: {
      writeBuffer,
      submit,
      onSubmittedWorkDone: vi.fn(() => {
        const completion = deferred();
        completions.push(completion);
        return completion.promise;
      }),
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
    buffers,
    completions,
    writeBuffer,
    submit,
    drawIndexed,
    createBindGroup,
  };
}

const identity = { documentId: 'primary-review', pageId: 'page' };
function rectangle(id: string, x = 0): RenderNodeSnapshot {
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

async function setup() {
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
  mirror.replaceSnapshot({ identity, revision: 0, nodes: [rectangle('a')], rootOrder: ['a'] });
  const source = new PrimitiveSceneSource(mirror);
  const prepare = (): PrimitivePacket => {
    const packet = source.prepare(target);
    if (!packet) throw new Error('Expected initialized packet');
    return packet;
  };
  const send = () => {
    const packet = prepare();
    const result = scene.submitPrimitivePacket(packet);
    expect(result.status).toBe('submitted');
    if (result.status === 'submitted') source.acknowledge(result.receipt);
    return packet;
  };
  return { ...native, accounting, creation, scene, mirror, source, target, prepare, send };
}

describe('Primary independent native packet review', () => {
  it('rejects bad layout, overlapping or out-of-range writes, and device exhaustion before upload', async () => {
    const fixture = await setup();
    const packet = fixture.prepare();
    const first = packet.writes[0]!;
    fixture.writeBuffer.mockClear();
    const invalidPackets = [
      { ...packet, layoutVersion: 2 },
      { ...packet, writes: [first, ...packet.writes] },
      { ...packet, writes: [{ ...first, byteOffset: 512 }, ...packet.writes.slice(1)] },
      {
        ...packet,
        writes: [{ ...first, incarnation: Symbol('foreign') }, ...packet.writes.slice(1)],
      },
    ];
    for (const invalid of invalidPackets) {
      expect(fixture.scene.submitPrimitivePacket(invalid as PrimitivePacket)).toEqual({
        status: 'failed',
        reason: 'invalid-packet',
      });
    }
    const bufferLimit = fixture.device.limits.maxBufferSize;
    Object.defineProperty(fixture.device.limits, 'maxBufferSize', {
      value: 2048,
      configurable: true,
    });
    expect(fixture.scene.submitPrimitivePacket(packet)).toEqual({
      status: 'failed',
      reason: 'allocation-failed',
    });
    expect(fixture.writeBuffer).not.toHaveBeenCalled();
    expect(fixture.submit).not.toHaveBeenCalled();
    expect(fixture.buffers).toHaveLength(2);
    Object.defineProperty(fixture.device.limits, 'maxBufferSize', {
      value: bufferLimit,
      configurable: true,
    });
    fixture.send();
    fixture.creation.dispose();
    expect(fixture.accounting.snapshot().live).toBe(0);
  });

  it('releases pending creation immediately and ignores the late pipeline result', async () => {
    const fixture = nativeFixture();
    const accounting = new ResourceAccounting();
    let resolvePipeline!: (pipeline: GPURenderPipeline) => void;
    vi.spyOn(fixture.device, 'createRenderPipelineAsync').mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolvePipeline = resolve;
        }),
    );
    const creation = createNativePrimitiveSceneCreation(
      fixture.device,
      fixture.context,
      'bgra8unorm',
      1,
      accounting,
    );
    await Promise.resolve();
    expect(fixture.buffers).toHaveLength(2);
    expect(accounting.snapshot().byCategory.buffer.liveBytes).toBe(44);
    creation.dispose();
    expect(accounting.snapshot().live).toBe(0);
    for (const buffer of fixture.buffers) expect(buffer.destroy).toHaveBeenCalledTimes(1);
    resolvePipeline({} as GPURenderPipeline);
    await expect(creation.result).rejects.toThrow();
    creation.dispose();
    expect(accounting.snapshot().live).toBe(0);
    for (const buffer of fixture.buffers) expect(buffer.destroy).toHaveBeenCalledTimes(1);
  });

  it('ignores old-generation completion while the shared ledger tracks a rebuilt scene', async () => {
    const old = await setup();
    old.send();
    old.creation.dispose();
    const fresh = nativeFixture();
    const creation = createNativePrimitiveSceneCreation(
      fresh.device,
      fresh.context,
      'bgra8unorm',
      2,
      old.accounting,
    );
    const { scene } = await creation.result;
    const target = { ...old.target, generation: 2, sampleCount: scene.sampleCount };
    scene.setTarget(target);
    const packet = old.source.prepare(target)!;
    expect(scene.submitPrimitivePacket(packet).status).toBe('submitted');
    const live = old.accounting.snapshot();
    old.completions[0]?.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(old.accounting.snapshot()).toEqual(live);
    for (const buffer of fresh.buffers) expect(buffer.destroy).not.toHaveBeenCalled();
    creation.dispose();
    expect(old.accounting.snapshot().live).toBe(0);
  });

  it('rejects mismatched envelope identity and accepts reconstruction after a missing acknowledgment', async () => {
    const fixture = await setup();
    const packet = fixture.prepare();
    fixture.writeBuffer.mockClear();
    for (const invalid of [
      { ...packet, surfaceRevision: packet.surfaceRevision + 1 },
      { ...packet, scene: { ...packet.scene, revision: -1 } },
      { ...packet, sceneEpoch: undefined },
      { ...packet, packetId: undefined },
    ]) {
      expect(fixture.scene.submitPrimitivePacket(invalid as PrimitivePacket)).toEqual({
        status: 'failed',
        reason: 'invalid-packet',
      });
    }
    expect(fixture.writeBuffer).not.toHaveBeenCalled();
    expect(fixture.submit).not.toHaveBeenCalled();
    expect(fixture.scene.submitPrimitivePacket(packet).status).toBe('submitted');
    const retry = fixture.prepare();
    expect(retry.mode).toBe('reconstruct');
    expect(fixture.scene.submitPrimitivePacket(retry).status).toBe('submitted');
    fixture.creation.dispose();
    expect(fixture.accounting.snapshot().live).toBe(0);
  });

  it('retries the same resized target after attachment allocation failure', async () => {
    const fixture = await setup();
    const createTexture = vi.spyOn(fixture.device, 'createTexture');
    createTexture.mockImplementationOnce(() => {
      throw new Error('injected attachment allocation failure');
    });
    const resized = { ...fixture.target, surfaceRevision: 2, width: 800 };
    expect(() => fixture.scene.setTarget(resized)).toThrow();
    const beforeRetry = createTexture.mock.calls.length;
    fixture.scene.setTarget(resized);
    expect(createTexture.mock.calls.length).toBe(beforeRetry + 1);
    fixture.creation.dispose();
    expect(fixture.accounting.snapshot().live).toBe(0);
  });

  it('rejects an in-capacity but uninitialized order slot before any native write', async () => {
    const fixture = await setup();
    const packet = fixture.prepare();
    const bad = {
      ...packet,
      writes: packet.writes.map((write) =>
        write.resourceId === 'order'
          ? { ...write, bytes: new Uint8Array(new Uint32Array([15]).buffer) }
          : write,
      ),
    };
    fixture.writeBuffer.mockClear();
    expect(fixture.scene.submitPrimitivePacket(bad)).toEqual({
      status: 'failed',
      reason: 'invalid-packet',
    });
    expect(fixture.writeBuffer).not.toHaveBeenCalled();
    expect(fixture.submit).not.toHaveBeenCalled();
    fixture.send();
    expect(fixture.drawIndexed).toHaveBeenCalledWith(6, 1, 0, 0, 0);
    fixture.creation.dispose();
    expect(fixture.accounting.snapshot().live).toBe(0);
  });

  it('keeps the retired arena alive past its first completion when an unchanged draw used it again', async () => {
    const fixture = await setup();
    fixture.send();
    const original = fixture.buffers.find((buffer) => buffer.size === 4096);
    expect(original).toBeDefined();
    expect(fixture.send().writes).toHaveLength(0);
    const nodes = Array.from({ length: 17 }, (_, index) => rectangle(`n${index}`, index * 12));
    fixture.mirror.replaceSnapshot({
      identity,
      revision: 1,
      nodes,
      rootOrder: nodes.map((n) => n.id),
    });
    fixture.send();
    expect(fixture.buffers.some((buffer) => buffer.size === 8192)).toBe(true);
    expect(fixture.accounting.snapshot().byCategory.buffer.liveBytes).toBe(4096 + 8192 + 44);
    expect(original?.destroy).not.toHaveBeenCalled();
    fixture.completions[0]?.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(original?.destroy).not.toHaveBeenCalled();
    expect(fixture.completions).toHaveLength(2);
    fixture.completions[1]?.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(original?.destroy).toHaveBeenCalledTimes(1);
    expect(fixture.accounting.snapshot().byCategory.buffer.liveBytes).toBe(8192 + 44);
    fixture.creation.dispose();
    fixture.creation.dispose();
    expect(fixture.accounting.snapshot().live).toBe(0);
    for (const buffer of fixture.buffers) expect(buffer.destroy).toHaveBeenCalledTimes(1);
  });

  it('does not acknowledge a failed upload and retries the exact transform range before drawing', async () => {
    const fixture = await setup();
    fixture.send();
    fixture.mirror.applyChanges({
      identity,
      baseRevision: 0,
      revision: 1,
      inserted: [],
      updated: [rectangle('a', 0.5)],
      removed: [],
      orders: [],
    });
    fixture.writeBuffer.mockClear();
    fixture.submit.mockClear();
    fixture.writeBuffer.mockImplementationOnce(() => {
      throw new Error('injected write failure');
    });
    const packet = fixture.prepare();
    expect(fixture.scene.submitPrimitivePacket(packet)).toEqual({
      status: 'failed',
      reason: 'submission-failed',
    });
    expect(fixture.submit).not.toHaveBeenCalled();
    const retry = fixture.send();
    expect(
      retry.writes.map((write) => [write.resourceId, write.byteOffset, write.bytes.byteLength]),
    ).toEqual([['transforms', 0, 32]]);
    expect(fixture.writeBuffer).toHaveBeenCalledTimes(2);
    expect(fixture.writeBuffer.mock.calls[1]?.[1]).toBe(0);
    expect(fixture.prepare().writes).toHaveLength(0);
    fixture.creation.dispose();
    expect(fixture.accounting.snapshot().live).toBe(0);
  });
});
