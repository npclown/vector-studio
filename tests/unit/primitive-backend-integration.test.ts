import type { RenderNodeSnapshot } from '@vector-studio/contracts';
import {
  PrimitiveRendererService,
  type AnimationFrameClock,
  type PrimitivePacket,
  type PrimitiveReceipt,
  type PrimitiveSubmitResult,
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

class ManualAnimationFrameClock implements AnimationFrameClock {
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

function deferred<Value>() {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function rectangle(x: number): RenderNodeSnapshot {
  return {
    id: 'a',
    parentId: null,
    kind: 'primitive',
    visible: true,
    opacity: 1,
    transform: [1, 0, 0, 1, x, 0],
    geometry: { kind: 'rectangle', width: 10, height: 10, cornerRadii: [0, 0, 0, 0] },
    style: { fill: { r: 1, g: 1, b: 1, a: 1 }, stroke: null },
  };
}

function makeReceipt(packet: PrimitivePacket, submissionSerial: number): PrimitiveReceipt {
  return Object.freeze({
    scene: packet.scene,
    sceneEpoch: packet.sceneEpoch,
    cameraRevision: packet.cameraRevision,
    surfaceRevision: packet.surfaceRevision,
    originRevision: packet.originRevision,
    generation: packet.generation,
    packetId: packet.packetId,
    submissionSerial,
    resources: Object.freeze(
      packet.resources.map((resource) =>
        Object.freeze({
          resourceId: resource.id,
          incarnation: resource.incarnation,
          records: Object.freeze(
            packet.writes
              .filter((write) => write.resourceId === resource.id)
              .flatMap((write) => write.records),
          ),
        }),
      ),
    ),
  });
}

function primitiveDevice(
  generation: number,
  request?: Promise<WebGpuDevicePort>,
  failedSubmissions = 0,
) {
  const loss = deferred<WebGpuDeviceLoss>();
  const packets: PrimitivePacket[] = [];
  let serial = 0;
  const scene: WebGpuPrimitiveScenePort = {
    sampleCount: 4,
    shaderModulesCreated: 1,
    pipelinesCreated: 1,
    setTarget: vi.fn(),
    submitPrimitivePacket: vi.fn((packet: PrimitivePacket): PrimitiveSubmitResult => {
      packets.push(packet);
      if (failedSubmissions > 0) {
        failedSubmissions -= 1;
        return { status: 'failed', reason: 'submission-failed' };
      }
      serial += 1;
      return { status: 'submitted' as const, receipt: makeReceipt(packet, serial) };
    }),
    dispose: vi.fn(),
  };
  let foundationSceneCreations = 0;
  const device: WebGpuDevicePort = {
    features: [],
    limits: { maxTextureDimension2D: 4096, maxBufferSize: 256 * 1024 * 1024 },
    lost: loss.promise,
    createFoundationScene: () => {
      foundationSceneCreations += 1;
      throw new Error('Foundation mode must not be created in this fixture.');
    },
    createPrimitiveScene: vi.fn(() => ({
      result: Promise.resolve({ scene, fellBackFrom4x: false }),
      dispose: () => scene.dispose(),
    })),
    waitForSubmittedWork: vi.fn(() => Promise.resolve()),
    subscribeErrors: vi.fn(() => ({ disposed: false, dispose: vi.fn() })),
    triggerValidationErrorForTesting: vi.fn(),
    destroy: vi.fn(),
  };
  const adapter: WebGpuAdapterPort = {
    info: { vendor: `test-${generation}` },
    requestDevice: vi.fn(() => request ?? Promise.resolve(device)),
  };
  return {
    adapter,
    device,
    scene,
    packets,
    loss,
    get foundationSceneCreations() {
      return foundationSceneCreations;
    },
  };
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

describe('primitive backend composition', () => {
  it('uses one backend RAF and rebuilds the latest accepted revision after recovery', async () => {
    const clock = new ManualAnimationFrameClock();
    const first = primitiveDevice(1);
    const delayedSecond = deferred<WebGpuDevicePort>();
    const second = primitiveDevice(2, delayedSecond.promise);
    const adapters = [first.adapter, second.adapter];
    const platform = platformFor(adapters);
    const backend = new WebGpuBackend({ platform, animationFrameClock: clock });
    const service = new PrimitiveRendererService(backend);
    backend.attachPrimitiveFrameSource(service);
    const identity = { documentId: 'backend-integration', pageId: 'page' };
    await expect(
      backend.initialize({
        canvas: { width: 0, height: 0 } as HTMLCanvasElement,
        cssSize: { width: 640, height: 360 },
        devicePixelRatio: 1,
      }),
    ).resolves.toMatchObject({ supported: true });
    clock.flush();
    expect(first.packets).toHaveLength(0);
    service.replaceSnapshot({ identity, revision: 4, nodes: [rectangle(0)], rootOrder: ['a'] });
    clock.flush();
    expect(first.packets).toHaveLength(1);
    expect(first.packets[0]).toMatchObject({
      generation: 1,
      mode: 'reconstruct',
      scene: { revision: 4 },
    });
    expect(first.foundationSceneCreations).toBe(0);

    service.applyChanges({
      identity,
      baseRevision: 4,
      revision: 5,
      inserted: [],
      updated: [rectangle(1)],
      removed: [],
      orders: [],
    });
    first.loss.resolve({ reason: 'unknown', message: 'injected loss' });
    await vi.waitFor(() => expect(backend.state).toBe('recovering'));
    service.applyChanges({
      identity,
      baseRevision: 5,
      revision: 6,
      inserted: [],
      updated: [rectangle(2)],
      removed: [],
      orders: [],
    });
    delayedSecond.resolve(second.device);
    await vi.waitFor(() => expect(backend.state).toBe('ready'));
    clock.flush();
    expect(second.packets).toHaveLength(1);
    expect(second.packets[0]).toMatchObject({
      generation: 2,
      mode: 'reconstruct',
      scene: { revision: 6 },
    });
    expect(backend.getStatistics()).toMatchObject({
      generation: 2,
      framesSubmitted: 2,
      pendingFrameCallbacks: 0,
      recoveryAttempts: 1,
    });
    backend.dispose();
    service.dispose();
  });

  it('does not acknowledge a failed submission and retries it on the same RAF owner', async () => {
    const clock = new ManualAnimationFrameClock();
    const native = primitiveDevice(1, undefined, 1);
    const backend = new WebGpuBackend({
      platform: platformFor([native.adapter]),
      animationFrameClock: clock,
    });
    const service = new PrimitiveRendererService(backend);
    const acknowledge = vi.spyOn(service, 'acknowledge');
    backend.attachPrimitiveFrameSource(service);
    const diagnostics: string[] = [];
    backend.subscribeDiagnostics((diagnostic) => diagnostics.push(diagnostic.code));
    service.replaceSnapshot({
      identity: { documentId: 'failed-submit', pageId: 'page' },
      revision: 0,
      nodes: [rectangle(0)],
      rootOrder: ['a'],
    });
    await backend.initialize({
      canvas: { width: 0, height: 0 } as HTMLCanvasElement,
      cssSize: { width: 640, height: 360 },
      devicePixelRatio: 1,
    });
    clock.flush();
    expect(acknowledge).not.toHaveBeenCalled();
    expect(diagnostics).toContain('render.submission-failed');
    expect(backend.getStatistics().framesSubmitted).toBe(0);
    backend.invalidate({ reason: 'interaction' });
    clock.flush();
    expect(acknowledge).toHaveBeenCalledOnce();
    expect(native.packets).toHaveLength(2);
    expect(native.packets[1]?.mode).toBe('reconstruct');
    expect(native.packets[1]?.writes).toEqual(native.packets[0]?.writes);
    backend.dispose();
    service.dispose();
  });

  it('skips stale submission and acknowledgment when preparation disposes and detaches', async () => {
    const clock = new ManualAnimationFrameClock();
    const native = primitiveDevice(1);
    const backend = new WebGpuBackend({
      platform: platformFor([native.adapter]),
      animationFrameClock: clock,
    });
    const service = new PrimitiveRendererService(backend);
    const attachment = backend.attachPrimitiveFrameSource(service);
    const identity = { documentId: 'reentrant-dispose', pageId: 'page' };
    service.replaceSnapshot({ identity, revision: 0, nodes: [rectangle(0)], rootOrder: ['a'] });
    const packet = service.prepare({
      generation: 1,
      surfaceRevision: 1,
      width: 640,
      height: 360,
      devicePixelRatio: 1,
      sampleCount: 4,
      targetFormat: 'bgra8unorm',
    })!;
    const acknowledge = vi.spyOn(service, 'acknowledge');
    vi.spyOn(service, 'prepare').mockImplementationOnce(() => {
      attachment.dispose();
      backend.dispose();
      return packet;
    });
    await backend.initialize({
      canvas: { width: 0, height: 0 } as HTMLCanvasElement,
      cssSize: { width: 640, height: 360 },
      devicePixelRatio: 1,
    });
    clock.flush();
    expect(native.packets).toHaveLength(0);
    expect(acknowledge).not.toHaveBeenCalled();
    expect(backend.state).toBe('disposed');
    service.dispose();
  });

  it('releases a primitive creation that settles after backend disposal', async () => {
    const clock = new ManualAnimationFrameClock();
    const gate = deferred<void>();
    const native = primitiveDevice(1);
    const lateDispose = vi.fn();
    let creationDisposed = false;
    let creationStarted = false;
    const device: WebGpuDevicePort = {
      ...native.device,
      createPrimitiveScene: () => {
        creationStarted = true;
        return {
          result: gate.promise.then(() => {
            if (creationDisposed) {
              lateDispose();
              throw new Error('late primitive creation');
            }
            return {
              scene: { ...native.scene, dispose: lateDispose },
              fellBackFrom4x: false,
            };
          }),
          dispose: () => {
            creationDisposed = true;
          },
        };
      },
    };
    const adapter: WebGpuAdapterPort = { info: {}, requestDevice: () => Promise.resolve(device) };
    const backend = new WebGpuBackend({
      platform: platformFor([adapter]),
      animationFrameClock: clock,
    });
    const service = new PrimitiveRendererService(backend);
    backend.attachPrimitiveFrameSource(service);
    const initialization = backend.initialize({
      canvas: { width: 0, height: 0 } as HTMLCanvasElement,
      cssSize: { width: 640, height: 360 },
      devicePixelRatio: 1,
    });
    await vi.waitFor(() => expect(creationStarted).toBe(true));
    backend.dispose();
    gate.resolve();
    await initialization;
    expect(lateDispose).toHaveBeenCalledOnce();
    expect(backend.getStatistics().resources.live).toBe(0);
    service.dispose();
  });
});
