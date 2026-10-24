import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { RendererDiagnostic, RenderNodeSnapshot } from '@vector-studio/contracts';
import {
  PrimitiveRendererService,
  ResourceAccounting,
  type AnimationFrameClock,
  type PrimitivePacket,
  type PrimitiveSubmitResult,
  type PrimitiveTarget,
} from '@vector-studio/renderer-core';
import {
  WebGpuBackend,
  type WebGpuAdapterPort,
  type WebGpuDeviceLoss,
  type WebGpuDevicePort,
  type WebGpuPlatform,
  type WebGpuPrimitiveScenePort,
} from '@vector-studio/renderer-webgpu';
import { describe, expect, it, vi } from 'vitest';

import { createNativePrimitiveSceneCreation } from '../../packages/renderer-webgpu/src/native-primitive-scene.js';
import { SharedBufferAllocator } from '../../packages/renderer-webgpu/src/shared-buffer-allocator.js';
import type { WebGpuCanvasContextPort } from '../../packages/renderer-webgpu/src/webgpu-platform.js';
import {
  createCountingPort,
  createFailingPort,
  createPathHarness,
  identity,
  pathNode,
  rectangleNode,
} from '../support/v3a-path-harness.js';
import { receiptOf } from '../support/v3b-mesh-harness.js';

// P3 V3 contract unit V3b, renderer-webgpu side (V3-A13, V3-A15): the mesh pipeline created at
// initialization and recovery, the mesh arena, merged paint-order encoding, the skipped mesh
// path, receipts and notices. It uses fake device seams; no host gets a port (V3-A18).
// Functional evidence only: precision is UNVERIFIED against the 0.25 physical-pixel target.

type Call = readonly [string, ...unknown[]];

function nativeFixture(
  options: Readonly<{
    limits?: Partial<Record<string, number>>;
    failMeshPipeline?: boolean;
    completes?: boolean;
  }> = {},
) {
  const calls: Call[] = [];
  const writes: Array<Readonly<{ buffer: string; offset: number; bytes: Uint8Array }>> = [];
  let bufferCreations = 0;
  const pipelineLabels: string[] = [];
  const shaderLabels: string[] = [];
  const completion = options.completes === true ? Promise.resolve() : new Promise<void>(() => {});
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
      ...options.limits,
    },
    createBuffer: vi.fn((descriptor: GPUBufferDescriptor) => {
      bufferCreations += 1;
      return { label: descriptor.label, destroy: vi.fn() };
    }),
    createBindGroupLayout: vi.fn((descriptor: GPUBindGroupLayoutDescriptor) => ({
      label: descriptor.label,
    })),
    createPipelineLayout: vi.fn(() => ({})),
    createBindGroup: vi.fn((descriptor: GPUBindGroupDescriptor) => ({ label: descriptor.label })),
    createShaderModule: vi.fn((descriptor: GPUShaderModuleDescriptor) => {
      shaderLabels.push(descriptor.label ?? '');
      return {};
    }),
    createRenderPipelineAsync: vi.fn((descriptor: GPURenderPipelineDescriptor) => {
      const label = descriptor.label ?? '';
      if (options.failMeshPipeline === true && label.includes('p3-mesh')) {
        return Promise.reject(new Error('injected mesh pipeline failure'));
      }
      pipelineLabels.push(label);
      return Promise.resolve({ label });
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
        end: () => calls.push(['end']),
      })),
      finish: vi.fn(() => ({})),
    })),
    queue: {
      writeBuffer: vi.fn(
        (
          buffer: { label: string },
          offset: number,
          data: Uint8Array,
          dataOffset?: number,
          size?: number,
        ) => {
          writes.push({
            buffer: buffer.label,
            offset,
            bytes: data.slice(dataOffset ?? 0, (dataOffset ?? 0) + (size ?? data.byteLength)),
          });
        },
      ),
      submit: vi.fn(),
      onSubmittedWorkDone: vi.fn(() => completion),
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
    writes,
    pipelineLabels,
    shaderLabels,
    get bufferCreations() {
      return bufferCreations;
    },
  };
}

async function nativeScene(
  fixture: ReturnType<typeof nativeFixture>,
  meshPipeline: boolean,
  generation = 1,
) {
  const accounting = new ResourceAccounting();
  const creation = createNativePrimitiveSceneCreation(
    fixture.device,
    fixture.context,
    'bgra8unorm',
    generation,
    accounting,
    meshPipeline ? { meshPipeline: true } : undefined,
  );
  const { scene } = await creation.result;
  const target: PrimitiveTarget = {
    generation,
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

const interleaved = (): RenderNodeSnapshot[] => [
  rectangleNode('r0', 0),
  pathNode('p1', 10),
  rectangleNode('r2', 20),
  pathNode('p3', 30),
  rectangleNode('r4', 40),
];

function submitted(result: PrimitiveSubmitResult) {
  if (result.status !== 'submitted') throw new Error(`not submitted: ${JSON.stringify(result)}`);
  return result.receipt;
}

describe('V3b mesh pipeline creation (V3-A13)', () => {
  it('V3-A13: creates the mesh pipeline at creation only when requested, never in a frame', async () => {
    const fixture = nativeFixture();
    const { scene, creation, accounting, target } = await nativeScene(fixture, true);
    expect(scene).toMatchObject({
      meshPipelineAvailable: true,
      pipelinesCreated: 3,
      shaderModulesCreated: 2,
    });
    expect(fixture.pipelineLabels).toEqual([
      'vector-studio/p1-analytic-primitive-4x',
      'vector-studio/p3-mesh-fill-4x',
      'vector-studio/p3-mesh-joint-4x',
    ]);
    const h = createPathHarness({ port: createCountingPort(), nodes: interleaved() });
    for (let frame = 0; frame < 5; frame += 1) {
      h.setZoom(1, { x: frame, y: 0 });
      const receipt = submitted(scene.submitPrimitivePacket(h.source.prepare(target)!));
      h.source.acknowledge(receipt);
    }
    // Five frames later, still exactly the three pipelines (ST-U7 adds the joint pipeline over
    // the same module) and two shader modules of creation.
    expect(fixture.pipelineLabels).toHaveLength(3);
    expect(fixture.shaderLabels).toHaveLength(2);
    creation.dispose();
    expect(accounting.snapshot().live).toBe(0);

    const plain = nativeFixture();
    const p1Only = await nativeScene(plain, false);
    expect(p1Only.scene).toMatchObject({ pipelinesCreated: 1, shaderModulesCreated: 1 });
    expect(p1Only.scene.meshPipelineAvailable).toBe(false);
    expect(plain.pipelineLabels).toEqual(['vector-studio/p1-analytic-primitive-4x']);
    p1Only.creation.dispose();
  });

  it('V3-A13: below the storage or binding limit, or on a failed pipeline creation, the mesh path is skipped and primitives still draw', async () => {
    for (const options of [
      { limits: { maxStorageBuffersPerShaderStage: 4 } },
      { limits: { maxBindingsPerBindGroup: 5 } },
      { failMeshPipeline: true },
    ]) {
      const fixture = nativeFixture(options);
      const { scene, creation, accounting, target } = await nativeScene(fixture, true);
      expect(scene).toMatchObject({ meshPipelineAvailable: false, pipelinesCreated: 1 });
      // No mesh object stays tracked after a failed creation.
      expect(accounting.snapshot().byCategory['render-pipeline'].live).toBe(1);
      expect(accounting.snapshot().byCategory['bind-group-layout'].live).toBe(1);
      const h = createPathHarness({ port: createCountingPort(), nodes: interleaved() });
      const packet = h.source.prepare(target)!;
      expect(packet.mesh!.draws).toHaveLength(2);
      const receipt = submitted(scene.submitPrimitivePacket(packet));
      expect(receipt.mesh).toEqual({ status: 'skipped' });
      expect(fixture.calls.filter(([name]) => name === 'draw')).toEqual([]);
      expect(fixture.calls.filter(([name]) => name === 'drawIndexed')).toHaveLength(3);
      // P1 writes only: quad vertices, quad indices and the P1 arena; no mesh arena.
      expect(fixture.bufferCreations).toBe(3);
      expect(fixture.writes.every((write) => !write.buffer.includes('mesh-arena'))).toBe(true);
      h.source.acknowledge(receipt);
      const next = h.source.prepare(target)!;
      expect(next.writes).toEqual([]);
      expect(next.draws).toEqual([{ first: 0, count: 3, variant: 'analytic-v1' }]);
      expect(next.mesh).toMatchObject({ resources: [], writes: [], draws: [] });
      expect(submitted(scene.submitPrimitivePacket(next)).mesh).toEqual({ status: 'skipped' });
      creation.dispose();
      expect(accounting.snapshot().live).toBe(0);
    }
  });
});

describe('V3b mesh submission (V3-A13)', () => {
  it('V3-A13: accepts packets with and without a mesh part and encodes draws in merged paint order', async () => {
    const fixture = nativeFixture();
    const { scene, creation, target } = await nativeScene(fixture, true);
    const h = createPathHarness({ port: createCountingPort(), nodes: interleaved() });
    const packet = h.source.prepare(target)!;
    const receipt = submitted(scene.submitPrimitivePacket(packet));
    expect(receipt.mesh).toMatchObject({
      status: 'submitted',
      originRevision: packet.mesh!.originRevision,
    });
    expect(
      receipt.mesh!.status === 'submitted' &&
        receipt.mesh!.resources.map((resource) => resource.resourceId),
    ).toEqual([
      'meshPositions',
      'meshTriangles',
      'meshFeatureLists',
      'meshFeatures',
      'meshInstances',
      'meshFrame',
    ]);
    const p1 = 'vector-studio/p1-analytic-primitive-4x';
    const mesh = 'vector-studio/p3-mesh-fill-4x';
    const encoded = fixture.calls.filter(([name]) =>
      ['setPipeline', 'drawIndexed', 'draw'].includes(name),
    );
    expect(encoded).toEqual([
      ['setPipeline', p1],
      ['drawIndexed', 6, 1, 0, 0, 0],
      ['setPipeline', mesh],
      ['draw', 6, 1, 0, 0],
      ['setPipeline', p1],
      ['drawIndexed', 6, 1, 0, 0, 1],
      ['setPipeline', mesh],
      ['draw', 6, 1, 6, 1],
      ['setPipeline', p1],
      ['drawIndexed', 6, 1, 0, 0, 2],
    ]);
    expect(
      fixture.calls.filter(([name]) => name === 'setBindGroup').map(([, label]) => label),
    ).toEqual([
      'primitive/1/arena-1/bind-group',
      'primitive/1/mesh-arena-2/bind-group',
      'primitive/1/arena-1/bind-group',
      'primitive/1/mesh-arena-2/bind-group',
      'primitive/1/arena-1/bind-group',
    ]);
    h.source.acknowledge(receipt);
    const quiet = h.source.prepare(target)!;
    expect(quiet.writes).toEqual([]);
    expect(quiet.mesh!.writes).toEqual([]);

    // A primitive-only packet gets a receipt without a mesh part and no mesh draw.
    fixture.calls.length = 0;
    const plain = createPathHarness({ port: createCountingPort(), nodes: [rectangleNode('r', 0)] });
    const primitiveOnly = plain.source.prepare(target)!;
    const plainReceipt = submitted(scene.submitPrimitivePacket(primitiveOnly));
    expect(plainReceipt).not.toHaveProperty('mesh');
    expect(fixture.calls.some(([name]) => name === 'draw')).toBe(false);
    creation.dispose();
  });

  it('V3-A13: rejects a bad position, mesh ranges beyond capacity and a zero triangleCount as invalid-packet', async () => {
    const fixture = nativeFixture();
    const { scene, creation, accounting, target } = await nativeScene(fixture, true);
    const h = createPathHarness({ port: createCountingPort(), nodes: interleaved() });
    const packet = h.source.prepare(target)!;
    const part = packet.mesh!;
    const [first, second] = part.draws;
    const withDraws = (draws: unknown[]): PrimitivePacket =>
      ({ ...packet, mesh: { ...part, draws } }) as unknown as PrimitivePacket;
    const before = accounting.snapshot();
    const invalid: PrimitivePacket[] = [
      withDraws([{ ...first, position: -1 }, second]),
      withDraws([first, { ...second, position: 4 }]),
      withDraws([{ ...first, position: 0.5 }, second]),
      withDraws([
        { ...first, position: 2 },
        { ...second, position: 1 },
      ]),
      withDraws([first, { ...second, triangleCount: 0 }]),
      withDraws([first, { ...second, firstTriangle: 16 * 32 }]),
      withDraws([first, { ...second, firstTriangle: 15, triangleCount: 2 }]),
      withDraws([first, { ...second, instance: 16 }]),
      withDraws([first, { ...second, instance: 5 }]),
      {
        ...packet,
        mesh: {
          ...part,
          resources: part.resources.map((resource) =>
            resource.id === 'meshFrame' ? { ...resource, capacityBytes: 64 } : resource,
          ),
        },
      },
      { ...packet, mesh: { ...part, resources: [], draws: [] } },
      { ...packet, mesh: { ...part, layoutVersion: 1 } } as unknown as PrimitivePacket,
    ];
    for (const candidate of invalid) {
      expect(scene.submitPrimitivePacket(candidate)).toEqual({
        status: 'failed',
        reason: 'invalid-packet',
      });
    }
    // The P1 arena created by each rejected preflight is released again.
    expect(accounting.snapshot().live).toBe(before.live);
    expect(fixture.calls.some(([name]) => name === 'draw')).toBe(false);
    expect(submitted(scene.submitPrimitivePacket(packet)).mesh).toMatchObject({
      status: 'submitted',
    });
    creation.dispose();
  });

  it('V3-A13: each submission marks both arenas; growth tracks the old and new mesh arenas until the old one retires', async () => {
    const markSubmitted = vi.spyOn(SharedBufferAllocator.prototype, 'markSubmitted');
    try {
      const fixture = nativeFixture();
      const { scene, creation, accounting, target } = await nativeScene(fixture, true);
      const h = createPathHarness({ port: createCountingPort(), nodes: interleaved() });
      markSubmitted.mockClear();
      h.source.acknowledge(submitted(scene.submitPrimitivePacket(h.source.prepare(target)!)));
      expect(markSubmitted).toHaveBeenCalledTimes(2);
      expect(markSubmitted.mock.calls[0]![1]).toBe(markSubmitted.mock.calls[1]![1]);
      expect(markSubmitted.mock.calls.map((call) => call[2].length)).toEqual([5, 6]);
      const buffersBefore = accounting.snapshot().byCategory.buffer;

      // 17 path slots grow meshInstances: the arena is replaced and both stay tracked.
      const many = Array.from({ length: 17 }, (_, index) => pathNode(`q${index}`, index * 12));
      // An incremental change keeps the P1 arena; only the mesh arena grows.
      const grow = (mirror: typeof h.mirror) =>
        expect(
          mirror.applyChanges({
            identity,
            baseRevision: 1,
            revision: 2,
            inserted: many,
            updated: [],
            removed: [],
            orders: [
              {
                parentId: null,
                children: [...interleaved().map(({ id }) => id), ...many.map(({ id }) => id)],
              },
            ],
          }).status,
        ).toBe('applied');
      grow(h.mirror);
      h.source.acknowledge(submitted(scene.submitPrimitivePacket(h.source.prepare(target)!)));
      const buffersAfter = accounting.snapshot().byCategory.buffer;
      expect(buffersAfter.live).toBe(buffersBefore.live + 1);
      expect(fixture.bufferCreations).toBe(5);
      creation.dispose();
      expect(accounting.snapshot().live).toBe(0);

      // When the GPU completes, the retired arena is released.
      const completing = nativeFixture({ completes: true });
      const run = await nativeScene(completing, true);
      const g = createPathHarness({ port: createCountingPort(), nodes: interleaved() });
      g.source.acknowledge(
        submitted(run.scene.submitPrimitivePacket(g.source.prepare(run.target)!)),
      );
      const settled = run.accounting.snapshot().byCategory.buffer.live;
      grow(g.mirror);
      g.source.acknowledge(
        submitted(run.scene.submitPrimitivePacket(g.source.prepare(run.target)!)),
      );
      await vi.waitFor(() =>
        expect(run.accounting.snapshot().byCategory.buffer.live).toBe(settled),
      );
      run.creation.dispose();
    } finally {
      markSubmitted.mockRestore();
    }
  });
});

describe('V3b device loss (V3-A15)', () => {
  it('V3-A15: a new generation accepts the reconstruct packet rebuilt from CPU meshes, with zero port calls and the pre-loss bytes', async () => {
    const port = createCountingPort();
    const h = createPathHarness({ port, nodes: interleaved() });
    const lost = nativeFixture();
    const first = await nativeScene(lost, true, 1);
    h.source.acknowledge(
      submitted(first.scene.submitPrimitivePacket(h.source.prepare(first.target)!)),
    );
    const meshBytes = (fixture: ReturnType<typeof nativeFixture>) =>
      fixture.writes
        .filter((write) => write.buffer.includes('mesh-arena'))
        .map((write) => [write.offset, Buffer.from(write.bytes).toString('hex')]);
    const before = meshBytes(lost);
    first.creation.dispose();
    const calls = port.callCount;

    const recovered = nativeFixture();
    const second = await nativeScene(recovered, true, 2);
    const packet = h.source.prepare(second.target)!;
    expect(packet.mode).toBe('reconstruct');
    const receipt = submitted(second.scene.submitPrimitivePacket(packet));
    expect(receipt.mesh).toMatchObject({ status: 'submitted' });
    expect(port.callCount).toBe(calls);
    expect(meshBytes(recovered)).toEqual(before);
    expect(recovered.calls.filter(([name]) => name === 'draw')).toHaveLength(2);
    second.creation.dispose();
  });
});

class ManualClock implements AnimationFrameClock {
  readonly #callbacks = new Map<number, (timestamp: number) => void>();
  #next = 1;
  request(callback: (timestamp: number) => void): number {
    const handle = this.#next;
    this.#next += 1;
    this.#callbacks.set(handle, callback);
    return handle;
  }
  cancel(handle: number): void {
    this.#callbacks.delete(handle);
  }
  flush(): void {
    const callbacks = [...this.#callbacks.values()];
    this.#callbacks.clear();
    for (const callback of callbacks) callback(16);
  }
}

function fakeDevice(
  meshPipelineAvailable: boolean,
  submit: (packet: PrimitivePacket) => PrimitiveSubmitResult,
) {
  let resolveLoss!: (loss: WebGpuDeviceLoss) => void;
  const lost = new Promise<WebGpuDeviceLoss>((resolve) => {
    resolveLoss = resolve;
  });
  const scene: WebGpuPrimitiveScenePort = {
    sampleCount: 4,
    shaderModulesCreated: meshPipelineAvailable ? 2 : 1,
    pipelinesCreated: meshPipelineAvailable ? 2 : 1,
    meshPipelineAvailable,
    setTarget: vi.fn(),
    submitPrimitivePacket: vi.fn(submit),
    dispose: vi.fn(),
  };
  const createPrimitiveScene = vi.fn((...args: unknown[]) => ({
    arity: args.length,
    result: Promise.resolve({ scene, fellBackFrom4x: false }),
    dispose: () => scene.dispose(),
  }));
  const device: WebGpuDevicePort = {
    features: [],
    limits: { maxTextureDimension2D: 4096, maxBufferSize: 256 * 1024 * 1024 },
    lost,
    createFoundationScene: () => {
      throw new Error('foundation mode is not used here');
    },
    createPrimitiveScene,
    waitForSubmittedWork: vi.fn(() => Promise.resolve()),
    subscribeErrors: vi.fn(() => ({ disposed: false, dispose: vi.fn() })),
    triggerValidationErrorForTesting: vi.fn(),
    destroy: vi.fn(),
  };
  const adapter: WebGpuAdapterPort = { info: {}, requestDevice: () => Promise.resolve(device) };
  return { adapter, createPrimitiveScene, scene, loss: resolveLoss };
}

function platformFor(adapters: WebGpuAdapterPort[]): WebGpuPlatform {
  const context = { configure: vi.fn(), unconfigure: vi.fn() };
  return {
    secureContext: true,
    apiAvailable: true,
    requestAdapter: vi.fn(() => Promise.resolve(adapters.shift() ?? null)),
    getCanvasContext: vi.fn(() => context),
    getPreferredCanvasFormat: vi.fn(() => 'bgra8unorm'),
  };
}

const surface = {
  canvas: { width: 0, height: 0 } as HTMLCanvasElement,
  cssSize: { width: 640, height: 360 },
  devicePixelRatio: 1,
};

const interim = (diagnostics: readonly RendererDiagnostic[]) =>
  diagnostics.filter((diagnostic) => diagnostic.code === 'render.path-mesh-failure');

describe('V3b backend lifecycle (V3-A13)', () => {
  it('V3-A13: reads requiresMeshPipeline at attach, requests the mesh pipeline at initialization and recovery, and emits mesh-pipeline-unavailable once per generation', async () => {
    let serial = 0;
    const accept = (packet: PrimitivePacket): PrimitiveSubmitResult => ({
      status: 'submitted',
      receipt: receiptOf(packet, 'skipped', (serial += 1)),
    });
    const first = fakeDevice(false, accept);
    const second = fakeDevice(false, accept);
    const clock = new ManualClock();
    const backend = new WebGpuBackend({
      platform: platformFor([first.adapter, second.adapter]),
      animationFrameClock: clock,
    });
    const diagnostics: RendererDiagnostic[] = [];
    backend.subscribeDiagnostics((diagnostic) => diagnostics.push(diagnostic));
    const service = new PrimitiveRendererService(backend, { fillMesh: createCountingPort() });
    backend.attachPrimitiveFrameSource(service);
    await backend.initialize(surface);
    expect(first.createPrimitiveScene.mock.calls[0]).toHaveLength(5);
    expect(first.createPrimitiveScene.mock.calls[0]![4]).toEqual({ meshPipeline: true });
    expect(interim(diagnostics).map((diagnostic) => diagnostic.context)).toEqual([
      {
        nodeId: null,
        failureScope: 'renderer',
        failureCode: 'mesh-pipeline-unavailable',
        toleranceExponent: null,
        paint: null,
      },
    ]);
    service.replaceSnapshot({
      identity,
      revision: 1,
      nodes: interleaved(),
      rootOrder: interleaved().map(({ id }) => id),
    });
    clock.flush();
    service.setCamera({ position: { x: 1, y: 0 }, zoom: 1 });
    clock.flush();
    expect(interim(diagnostics)).toHaveLength(1);

    first.loss({ reason: 'unknown', message: 'injected loss' });
    await vi.waitFor(() => {
      expect(backend.generation).toBe(2);
      expect(backend.state).toBe('ready');
    });
    expect(second.createPrimitiveScene.mock.calls[0]![4]).toEqual({ meshPipeline: true });
    expect(interim(diagnostics).map((diagnostic) => diagnostic.generation)).toEqual([1, 2]);
    backend.dispose();
    service.dispose();

    // A source without a port, or one that omits the flag, never requests the mesh pipeline.
    for (const source of [
      new PrimitiveRendererService({ invalidate: vi.fn(), setMode: vi.fn() }),
      { prepare: () => null, acknowledge: () => undefined },
    ]) {
      const plain = fakeDevice(false, accept);
      const plainBackend = new WebGpuBackend({ platform: platformFor([plain.adapter]) });
      const plainDiagnostics: RendererDiagnostic[] = [];
      plainBackend.subscribeDiagnostics((diagnostic) => plainDiagnostics.push(diagnostic));
      plainBackend.attachPrimitiveFrameSource(source);
      await plainBackend.initialize(surface);
      expect(plain.createPrimitiveScene.mock.calls[0]).toHaveLength(4);
      expect(interim(plainDiagnostics)).toEqual([]);
      plainBackend.dispose();
    }
  });

  it('V3-A13: emits each notice once with the section h context, even for a stale generation, up to the 32 a packet carries', async () => {
    let serial = 0;
    let stale = true;
    const device = fakeDevice(true, (packet) => {
      if (stale) {
        stale = false;
        return { status: 'stale-generation' };
      }
      return { status: 'submitted', receipt: receiptOf(packet, 'submitted', (serial += 1)) };
    });
    const clock = new ManualClock();
    const backend = new WebGpuBackend({
      platform: platformFor([device.adapter]),
      animationFrameClock: clock,
    });
    const diagnostics: RendererDiagnostic[] = [];
    backend.subscribeDiagnostics((diagnostic) => diagnostics.push(diagnostic));
    const tags = Array.from({ length: 40 }, (_, index) => index * 10);
    const service = new PrimitiveRendererService(backend, {
      fillMesh: createFailingPort({
        pathFailures: new Map(tags.map((tag) => [tag, 'unsupported-geometry'])),
      }),
    });
    backend.attachPrimitiveFrameSource(service);
    await backend.initialize(surface);
    const nodes = tags.map((tag, index) => pathNode(`p${String(index).padStart(2, '0')}`, tag));
    service.replaceSnapshot({ identity, revision: 1, nodes, rootOrder: nodes.map(({ id }) => id) });
    clock.flush();
    // The first packet was stale, yet its 32 notices were emitted.
    expect(interim(diagnostics)).toHaveLength(32);
    expect(backend.getStatistics().staleGenerationSubmissions).toBe(1);
    backend.invalidate({ reason: 'interaction' });
    clock.flush();
    const emitted = interim(diagnostics);
    expect(emitted).toHaveLength(40);
    expect(new Set(emitted.map((diagnostic) => diagnostic.context!.nodeId)).size).toBe(40);
    expect(emitted[0]).toMatchObject({
      severity: 'warning',
      generation: 1,
      context: {
        nodeId: 'p00',
        failureScope: 'path',
        failureCode: 'unsupported-geometry',
        toleranceExponent: -3,
      },
    });
    expect(emitted[0]!.message.startsWith('Path ')).toBe(true);
    backend.invalidate({ reason: 'interaction' });
    clock.flush();
    expect(interim(diagnostics)).toHaveLength(40);
    backend.dispose();
    service.dispose();
  });
});

// V4 removed the V3-A18 form of this test ("before V4") when the playground gained the real
// port. The remaining hosts still request no mesh pipeline and inject no port.
describe('V4 host injection', () => {
  it('V4: no host other than the path page, the ST-U8 stroke page, the V-1 appearance page, the V-2 path-data page and the V-3 integration page requests the mesh pipeline or injects a port', () => {
    const root = join(__dirname, '../../apps');
    const files: string[] = [];
    const walk = (directory: string) => {
      for (const entry of readdirSync(directory)) {
        if (entry === 'node_modules' || entry === 'dist') continue;
        const path = join(directory, entry);
        if (statSync(path).isDirectory()) walk(path);
        else if (/\.(ts|tsx|js|mjs|html|json)$/.test(entry)) files.push(path);
      }
    };
    walk(root);
    expect(files.length).toBeGreaterThan(0);
    // The V4 path page, the B2 ST-U8 stroke page (on V4's pattern), the visualization track's
    // V-1 appearance page, V-2 path-data page and V-3 integration page (same pattern) and the
    // manifest and project-reference edges inject the real ports.
    const host = files.filter(
      (file) =>
        /[\\/]src[\\/]p3-(v4-paths|b2-strokes)\.ts$/.test(file) ||
        /[\\/]src[\\/]viz-v1-appearance\.ts$/.test(file) ||
        /[\\/]src[\\/]viz-v2-path-data\.ts$/.test(file) ||
        /[\\/]src[\\/]viz-v3-integration\.ts$/.test(file) ||
        /[\\/]playground[\\/](package|tsconfig)\.json$/.test(file),
    );
    expect(host).toHaveLength(7);
    // The V3-A14 smoke fixture page and the E10-U3 test-hooks check page are test fixtures with a
    // static test-double port, not hosts; they must not reach a real port (no geometry-wasm).
    const fixture = files.filter((file) => /(p3-v3-mesh|e10-test-hooks)\.(ts|html)$/.test(file));
    expect(fixture).toHaveLength(4);
    for (const file of fixture)
      expect(readFileSync(file, 'utf8'), file).not.toMatch(/geometry-wasm/);
    const allowed = new Set([...host, ...fixture]);
    for (const file of files.filter((candidate) => !allowed.has(candidate))) {
      expect(readFileSync(file, 'utf8'), file).not.toMatch(
        /fillMesh|strokeMesh|geometry-wasm|requiresMeshPipeline|meshPipeline/,
      );
    }
  });
});
