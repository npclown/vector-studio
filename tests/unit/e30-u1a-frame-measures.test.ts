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
import { beforeEach, describe, expect, it, vi } from 'vitest';

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

// E30 contract, section 3 (U1a): the frame parts are User Timing measures only while frame
// measurement is active.
const NAMES = ['vs-prepare', 'vs-submit', 'vs-acknowledge', 'vs-gpu'];
const measures = (name: string) => performance.getEntriesByName(name, 'measure');
const total = () => NAMES.reduce((sum, name) => sum + measures(name).length, 0);

async function setup() {
  const clock = new ManualAnimationFrameClock();
  const native = primitiveDevice(1);
  const backend = new WebGpuBackend({
    platform: platformFor([native.adapter]),
    animationFrameClock: clock,
  });
  const service = new PrimitiveRendererService(backend);
  backend.attachPrimitiveFrameSource(service);
  await backend.initialize({
    canvas: { width: 0, height: 0 } as HTMLCanvasElement,
    cssSize: { width: 640, height: 360 },
    devicePixelRatio: 1,
  });
  const identity = { documentId: 'e30-u1a', pageId: 'page' };
  service.replaceSnapshot({ identity, revision: 1, nodes: [rectangle(0)], rootOrder: ['a'] });
  clock.flush();
  let revision = 1;
  /** One scene change and one frame, so every frame prepares, submits and acknowledges. */
  const frame = () => {
    revision += 1;
    service.applyChanges({
      identity,
      baseRevision: revision - 1,
      revision,
      inserted: [],
      updated: [rectangle(revision)],
      removed: [],
      orders: [],
    });
    clock.flush();
  };
  const wait = vi.spyOn(native.device, 'waitForSubmittedWork');
  return { backend, service, native, frame, wait };
}

describe('E30-U1a frame measures', () => {
  beforeEach(() => performance.clearMeasures());

  it('creates no measure while frame measurement is inactive', async () => {
    const { backend, service, native, frame } = await setup();
    for (let index = 0; index < 9; index += 1) frame();
    await Promise.resolve();
    expect(native.packets.length).toBe(10);
    expect(total()).toBe(0);
    backend.dispose();
    service.dispose();
  });

  it('measures prepare, submit and acknowledge per frame and the GPU every eighth frame', async () => {
    const { backend, service, frame, wait } = await setup();
    backend.startFrameMeasurements();
    for (let index = 0; index < 9; index += 1) frame();
    await vi.waitFor(() => expect(measures('vs-gpu')).toHaveLength(2));
    expect(measures('vs-prepare')).toHaveLength(9);
    expect(measures('vs-submit')).toHaveLength(9);
    expect(measures('vs-acknowledge')).toHaveLength(9);
    // Frames 1 and 9 of the window wait for the GPU; the others do not.
    expect(wait).toHaveBeenCalledTimes(2);
    for (const name of NAMES) {
      for (const entry of measures(name)) expect(entry.duration).toBeGreaterThanOrEqual(0);
    }

    backend.stopFrameMeasurements();
    performance.clearMeasures();
    frame();
    await Promise.resolve();
    expect(total()).toBe(0);
    expect(wait).toHaveBeenCalledTimes(2);
    backend.dispose();
    service.dispose();
  });

  it('measures prepare and submit, not acknowledge, when the submission fails', async () => {
    const { backend, service, native, frame, wait } = await setup();
    vi.spyOn(native.scene, 'submitPrimitivePacket').mockReturnValueOnce({
      status: 'failed',
      reason: 'submission-failed',
    });
    backend.startFrameMeasurements();
    frame();
    expect(measures('vs-prepare')).toHaveLength(1);
    expect(measures('vs-submit')).toHaveLength(1);
    expect(measures('vs-acknowledge')).toHaveLength(0);
    expect(wait).not.toHaveBeenCalled();
    backend.dispose();
    service.dispose();
  });
  it('drops a GPU wait that settles after the window stopped or restarted', async () => {
    const { backend, service, frame, wait } = await setup();
    const pending: (() => void)[] = [];
    wait.mockImplementation(() => new Promise<void>((resolve) => pending.push(resolve)));
    backend.startFrameMeasurements();
    frame();
    backend.stopFrameMeasurements();
    pending.shift()!();
    await Promise.resolve();
    await Promise.resolve();
    expect(measures('vs-gpu')).toHaveLength(0);

    backend.startFrameMeasurements();
    frame();
    backend.startFrameMeasurements();
    pending.shift()!();
    await Promise.resolve();
    await Promise.resolve();
    expect(measures('vs-gpu')).toHaveLength(0);

    frame();
    pending.shift()!();
    await vi.waitFor(() => expect(measures('vs-gpu')).toHaveLength(1));
    backend.dispose();
    service.dispose();
  });
});
