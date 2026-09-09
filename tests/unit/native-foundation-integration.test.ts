import { describe, expect, it, vi } from 'vitest';

import {
  FoundationExperiment,
  type FoundationBindingSource,
} from '../../packages/renderer-webgpu/src/foundation-experiment.js';
import { createNativeFoundationSceneCreation } from '../../packages/renderer-webgpu/src/native-foundation-scene.js';
import type { WebGpuCanvasContextPort } from '../../packages/renderer-webgpu/src/webgpu-platform.js';

const REFERENCE_NDC = [0, 0.65, -0.6, -0.55, 0.6, -0.55] as const;
const REFERENCE_COLORS = [0.35, 0.75, 1, 0.68, 0.35, 1, 1, 0.42, 0.55] as const;

interface Deferred<Value> {
  readonly promise: Promise<Value>;
  resolve(value: Value): void;
  reject(reason: Error): void;
}

function deferred<Value>(): Deferred<Value> {
  let resolvePromise!: (value: Value) => void;
  let rejectPromise!: (reason: Error) => void;
  const promise = new Promise<Value>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}

interface NativeDeviceFixture {
  readonly device: GPUDevice;
  readonly buffer: GPUBuffer;
  readonly bufferDestroy: ReturnType<typeof vi.fn>;
  readonly submit: ReturnType<typeof vi.fn>;
  readonly writeBuffer: ReturnType<typeof vi.fn>;
  readonly createBuffer: ReturnType<typeof vi.fn>;
  readonly createPipeline: ReturnType<typeof vi.fn>;
  readonly onSubmittedWorkDone: ReturnType<typeof vi.fn>;
  readonly passSetVertexBuffer: ReturnType<typeof vi.fn>;
  readonly passSetPipeline: ReturnType<typeof vi.fn>;
  readonly pipelineDescriptors: GPURenderPipelineDescriptor[];
}

function nativeDevice(
  options: {
    createPipeline?: (descriptor: GPURenderPipelineDescriptor) => Promise<GPURenderPipeline>;
    onSubmittedWorkDone?: () => Promise<void>;
    submit?: () => void;
    failAt?: 'buffer' | 'position-write' | 'color-write' | 'shader';
  } = {},
): NativeDeviceFixture {
  const bufferDestroy = vi.fn();
  const buffer = { destroy: bufferDestroy } as unknown as GPUBuffer;
  const pipelineDescriptors: GPURenderPipelineDescriptor[] = [];
  let writeCount = 0;
  const writeBuffer = vi.fn(() => {
    writeCount += 1;
    if (options.failAt === 'position-write' && writeCount === 1) {
      throw new Error('position upload failed');
    }
    if (options.failAt === 'color-write' && writeCount === 2) {
      throw new Error('color upload failed');
    }
  });
  const createBuffer = vi.fn(() => {
    if (options.failAt === 'buffer') throw new Error('buffer creation failed');
    return buffer;
  });
  const createPipeline = vi.fn((descriptor: GPURenderPipelineDescriptor) => {
    pipelineDescriptors.push(descriptor);
    return (
      options.createPipeline?.(descriptor) ??
      Promise.resolve({ label: descriptor.label } as GPURenderPipeline)
    );
  });
  const submit = vi.fn(() => options.submit?.());
  const onSubmittedWorkDone = vi.fn(() => options.onSubmittedWorkDone?.() ?? Promise.resolve());
  const passSetVertexBuffer = vi.fn();
  const passSetPipeline = vi.fn();
  const pass = {
    setPipeline: passSetPipeline,
    setVertexBuffer: passSetVertexBuffer,
    draw: vi.fn(),
    end: vi.fn(),
  };
  const device = {
    createBuffer,
    createShaderModule: vi.fn(() => {
      if (options.failAt === 'shader') throw new Error('shader creation failed');
      return {} as GPUShaderModule;
    }),
    createRenderPipelineAsync: createPipeline,
    createTexture: vi.fn(() => ({
      createView: vi.fn(() => ({}) as GPUTextureView),
      destroy: vi.fn(),
    })),
    createCommandEncoder: vi.fn(() => ({
      beginRenderPass: vi.fn(() => pass),
      finish: vi.fn(() => ({}) as GPUCommandBuffer),
    })),
    queue: { writeBuffer, submit, onSubmittedWorkDone },
  } as unknown as GPUDevice;

  return {
    device,
    buffer,
    bufferDestroy,
    submit,
    writeBuffer,
    createBuffer,
    createPipeline,
    onSubmittedWorkDone,
    passSetVertexBuffer,
    passSetPipeline,
    pipelineDescriptors,
  };
}

function canvasContext(): WebGpuCanvasContextPort {
  return {
    native: {
      getCurrentTexture: () => ({ createView: () => ({}) }),
    },
    configure: vi.fn(),
    unconfigure: vi.fn(),
  } as unknown as WebGpuCanvasContextPort;
}

async function createScene(
  fixture: NativeDeviceFixture,
  experiment = new FoundationExperiment(1),
  generation = 1,
  size = { width: 640, height: 360 },
  dpr = 1,
) {
  const source = experiment.createBinding(generation, size, dpr);
  const creation = createNativeFoundationSceneCreation(fixture.device, 'bgra8unorm', source);
  return { experiment, creation, ...(await creation.result) };
}

function uploadedValues(call: unknown[] | undefined): number[] {
  const data = call?.[2];
  if (!(data instanceof Float32Array)) throw new Error('Expected a Float32 upload.');
  return [...data];
}

function expectNumbersClose(
  actual: readonly number[],
  expected: readonly number[],
  tolerance = 1e-10,
): void {
  expect(actual).toHaveLength(expected.length);
  expected.forEach((value, index) => {
    expect(Math.abs((actual[index] ?? Number.NaN) - value)).toBeLessThanOrEqual(tolerance);
  });
}

describe('native foundation allocation, camera, and pipeline integration', () => {
  it('uploads two allocations into one 256-byte buffer and binds split vertex layouts', async () => {
    const fixture = nativeDevice();
    const { experiment, scene } = await createScene(fixture);

    expect(fixture.createBuffer).toHaveBeenCalledWith(
      expect.objectContaining({ size: 256, usage: 0x28 }),
    );
    expect(fixture.writeBuffer).toHaveBeenCalledTimes(2);
    expect(fixture.writeBuffer.mock.calls[0]?.[1]).toBe(0);
    expect(fixture.writeBuffer.mock.calls[1]?.[1]).toBe(24);
    expectNumbersClose(uploadedValues(fixture.writeBuffer.mock.calls[0]), REFERENCE_NDC, 1e-6);
    expectNumbersClose(uploadedValues(fixture.writeBuffer.mock.calls[1]), REFERENCE_COLORS, 1e-6);

    const snapshot = experiment.snapshot();
    expect(snapshot.allocations).toEqual({
      positions: { id: 1, offset: 0, requestedBytes: 24, allocatedBytes: 24 },
      colors: { id: 2, offset: 24, requestedBytes: 36, allocatedBytes: 36 },
    });
    expect(snapshot.allocator).toMatchObject({
      capacityBytes: 256,
      alignment: 4,
      liveAllocationCount: 2,
      liveRequestedBytes: 60,
      liveAllocatedBytes: 60,
      peakReservedBytes: 60,
    });
    expect(scene.staticResources).toContainEqual({
      id: 'foundation-vertices',
      descriptor: { category: 'buffer', size: 256 },
    });
    expect(scene.staticResources).toContainEqual({
      id: 'foundation-vertices',
      descriptor: { category: 'buffer', size: 256 },
    });
    expect(fixture.createPipeline).toHaveBeenCalledTimes(1);
    expect(experiment.snapshot().pipelineRequests).toBe(2);
    expect(fixture.pipelineDescriptors[0]?.vertex.buffers).toEqual([
      {
        arrayStride: 8,
        attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x2' }],
      },
      {
        arrayStride: 12,
        attributes: [{ shaderLocation: 1, offset: 0, format: 'float32x3' }],
      },
    ]);

    scene.render(canvasContext());
    expect(fixture.passSetVertexBuffer).toHaveBeenNthCalledWith(1, 0, fixture.buffer, 0, 24);
    expect(fixture.passSetVertexBuffer).toHaveBeenNthCalledWith(2, 1, fixture.buffer, 24, 36);
    scene.render(canvasContext());
    expect(fixture.createPipeline).toHaveBeenCalledTimes(1);
    await Promise.resolve();

    scene.dispose();
    experiment.dispose();
    expect(experiment.snapshot()).toMatchObject({
      liveBackingBuffers: 0,
      livePipelines: 0,
      allocator: { liveAllocationCount: 0, reservedBytes: 0 },
    });
  });

  it('keeps the normalized triangle while deriving independent document and physical coordinates', async () => {
    const fixture = nativeDevice();
    const { experiment, scene } = await createScene(fixture);
    const initial = experiment.snapshot();
    expectNumbersClose(
      initial.documentVertices,
      [193.33333333333334, 32, 65.33333333333333, 176, 321.3333333333333, 176],
    );
    expectNumbersClose(initial.physicalVertices, [320, 63, 128, 279, 512, 279]);
    expectNumbersClose(initial.ndcVertices, REFERENCE_NDC);

    scene.resize({ width: 640, height: 360 }, 2);
    const highDpr = experiment.snapshot();
    expect(highDpr.camera.devicePixelRatio).toBe(2);
    expectNumbersClose(
      highDpr.documentVertices,
      [86.66666666666667, 11, 22.66666666666667, 83, 150.66666666666666, 83],
    );
    expectNumbersClose(highDpr.physicalVertices, [320, 63, 128, 279, 512, 279]);
    expectNumbersClose(highDpr.ndcVertices, REFERENCE_NDC);

    scene.resize({ width: 100, height: 50 }, 1.5);
    const clamped = experiment.snapshot();
    expect(clamped.physicalSize).toEqual({ width: 100, height: 50 });
    expectNumbersClose(
      clamped.documentVertices,
      [
        2.2222222222222214, -6.111111111111111, -11.11111111111111, 7.222222222222221,
        15.555555555555557, 7.222222222222221,
      ],
    );
    expectNumbersClose(clamped.physicalVertices, [50, 8.75, 20, 38.75, 80, 38.75]);
    expectNumbersClose(clamped.ndcVertices, REFERENCE_NDC);

    scene.resize({ width: 0, height: 50 }, 1.5);
    expect(experiment.snapshot()).toMatchObject({
      documentVertices: [],
      physicalVertices: [],
      ndcVertices: REFERENCE_NDC,
    });
    scene.resize({ width: 640, height: 360 }, 1);
    const resumed = experiment.snapshot();
    expectNumbersClose(resumed.documentVertices, initial.documentVertices);
    expectNumbersClose(resumed.physicalVertices, initial.physicalVertices);
    expectNumbersClose(resumed.ndcVertices, REFERENCE_NDC);

    scene.dispose();
    experiment.dispose();
  });

  it('keeps the fixed camera-triangle document payload across DPR, suspension, and recovery', () => {
    const experiment = new FoundationExperiment(1, 'camera-triangle-v1');
    const first = experiment.createBinding(1, { width: 640, height: 360 }, 1);
    const initial = experiment.snapshot();
    const allocations = initial.allocations;

    expect(initial.documentVertices).toEqual([0, 0, 100, 0, 0, 60]);
    expect(Object.isFrozen(initial.documentVertices)).toBe(true);
    expectNumbersClose(initial.physicalVertices, [30, 15, 180, 15, 30, 105]);

    first.updateSurface({ width: 1280, height: 720 }, 2);
    expectNumbersClose(experiment.snapshot().physicalVertices, [60, 30, 360, 30, 60, 210]);

    first.updateSurface({ width: 0, height: 720 }, 2);
    const suspended = experiment.snapshot();
    expect(suspended.documentVertices).toEqual([0, 0, 100, 0, 0, 60]);
    expectNumbersClose(suspended.physicalVertices, [60, 30, 360, 30, 60, 210]);

    first.detach();
    experiment.advanceGeneration(2);
    const recovered = experiment.createBinding(2, { width: 960, height: 540 }, 1.5);
    const recoverySnapshot = experiment.snapshot();
    expect(recoverySnapshot.allocations).toEqual(allocations);
    expect(recoverySnapshot.documentVertices).toEqual([0, 0, 100, 0, 0, 60]);
    expectNumbersClose(recoverySnapshot.physicalVertices, [45, 22.5, 270, 22.5, 45, 157.5]);

    recovered.detach();
    experiment.dispose();
  });

  it('falls back from one deduplicated 4x request to one deduplicated 1x request', async () => {
    const fixture = nativeDevice({
      createPipeline: (descriptor) => {
        const count = descriptor.multisample?.count ?? 1;
        return count === 4
          ? Promise.reject(new Error('4x unsupported'))
          : Promise.resolve({ label: '1x' } as GPURenderPipeline);
      },
    });
    const { experiment, scene, fellBackFrom4x } = await createScene(fixture);

    expect(fellBackFrom4x).toBe(true);
    expect(scene.sampleCount).toBe(1);
    expect(fixture.createPipeline).toHaveBeenCalledTimes(2);
    expect(fixture.pipelineDescriptors.map((descriptor) => descriptor.multisample?.count)).toEqual([
      4, 1,
    ]);
    expect(experiment.snapshot()).toMatchObject({
      pipelineCreations: 1,
      livePipelines: 1,
      cache: { readyEntries: 1, pendingEntries: 0, successfulCreations: 1 },
    });

    scene.render(canvasContext());
    scene.render(canvasContext());
    expect(fixture.createPipeline).toHaveBeenCalledTimes(2);
    scene.dispose();
    experiment.dispose();
  });
});

describe('native foundation submission and generation ownership', () => {
  it('coalesces delayed completions, ignores rejection, retries observation, and never registers a thrown submit', async () => {
    const firstCompletion = deferred<void>();
    const retryCompletion = deferred<void>();
    const completions = [firstCompletion.promise, retryCompletion.promise];
    const fixture = nativeDevice({
      onSubmittedWorkDone: () => {
        const completion = completions.shift();
        if (completion === undefined) throw new Error('completion observer failed');
        return completion;
      },
    });
    const { experiment, scene } = await createScene(fixture);
    const context = canvasContext();

    scene.render(context);
    scene.render(context);
    expect(experiment.snapshot()).toMatchObject({ submittedSerial: 2, completedSerial: 0 });
    expect(fixture.onSubmittedWorkDone).toHaveBeenCalledTimes(1);
    firstCompletion.resolve();
    await Promise.resolve();
    expect(experiment.snapshot().completedSerial).toBe(1);
    expect(fixture.onSubmittedWorkDone).toHaveBeenCalledTimes(2);

    retryCompletion.reject(new Error('queue completion rejected'));
    await Promise.resolve();
    expect(experiment.snapshot().completedSerial).toBe(1);
    scene.render(context);
    expect(experiment.snapshot()).toMatchObject({ submittedSerial: 3, completedSerial: 1 });
    expect(fixture.onSubmittedWorkDone).toHaveBeenCalledTimes(3);

    scene.dispose();
    experiment.dispose();

    const throwing = nativeDevice({
      submit: () => {
        throw new Error('submit failed');
      },
    });
    const failed = await createScene(throwing);
    expect(() => failed.scene.render(canvasContext())).toThrow('submit failed');
    expect(failed.experiment.snapshot()).toMatchObject({
      submittedSerial: 0,
      completedSerial: 0,
    });
    expect(throwing.onSubmittedWorkDone).not.toHaveBeenCalled();
    failed.scene.dispose();
    failed.experiment.dispose();

    const preflight = nativeDevice();
    const preflightExperiment = new FoundationExperiment(1);
    const binding = preflightExperiment.createBinding(1, { width: 640, height: 360 }, 1);
    const rejectedPreflight = {
      ...binding,
      prepareSubmission: () => {
        throw new RangeError('serial exhausted');
      },
    } satisfies FoundationBindingSource;
    const preflightCreation = createNativeFoundationSceneCreation(
      preflight.device,
      'bgra8unorm',
      rejectedPreflight,
    );
    const preflightScene = (await preflightCreation.result).scene;
    expect(() => preflightScene.render(canvasContext())).toThrow('serial exhausted');
    expect(preflight.submit).not.toHaveBeenCalled();
    preflightScene.dispose();
    preflightExperiment.dispose();
  });

  it('preserves descriptors while rebuilding native resources and ignores stale completion', async () => {
    const staleCompletion = deferred<void>();
    const firstDevice = nativeDevice({ onSubmittedWorkDone: () => staleCompletion.promise });
    const experiment = new FoundationExperiment(1);
    const first = await createScene(firstDevice, experiment);
    first.scene.render(canvasContext());
    const allocations = experiment.snapshot().allocations;
    first.scene.dispose();
    experiment.advanceGeneration(2);

    const recoveredCompletion = deferred<void>();
    const secondDevice = nativeDevice({ onSubmittedWorkDone: () => recoveredCompletion.promise });
    const second = await createScene(secondDevice, experiment, 2);
    const recoveredSnapshot = experiment.snapshot();
    expect(recoveredSnapshot.allocations.positions).toBe(allocations.positions);
    expect(recoveredSnapshot.allocations.colors).toBe(allocations.colors);
    expect(recoveredSnapshot).toMatchObject({
      bindingGeneration: 2,
      backingBufferCreations: 2,
      liveBackingBuffers: 1,
      pipelineCreations: 2,
      livePipelines: 1,
      submittedSerial: 0,
      completedSerial: 0,
      cache: { generation: 2, readyEntries: 1 },
    });
    expect(firstDevice.buffer).not.toBe(secondDevice.buffer);

    staleCompletion.resolve();
    await Promise.resolve();
    expect(experiment.snapshot().completedSerial).toBe(0);
    second.scene.render(canvasContext());
    recoveredCompletion.resolve();
    await Promise.resolve();
    expect(experiment.snapshot()).toMatchObject({ submittedSerial: 1, completedSerial: 1 });

    second.scene.dispose();
    experiment.dispose();
    expect(experiment.snapshot()).toMatchObject({
      liveBackingBuffers: 0,
      livePipelines: 0,
      allocator: { liveAllocationCount: 0, reservedBytes: 0 },
    });
  });

  it('retries an aborted attempt on a new native device without replacing descriptors', async () => {
    const firstPipeline = { label: 'aborted' } as GPURenderPipeline;
    const pendingPipeline = deferred<GPURenderPipeline>();
    const firstDevice = nativeDevice({ createPipeline: () => pendingPipeline.promise });
    const experiment = new FoundationExperiment(1);
    const allocations = experiment.snapshot().allocations;
    const firstSource = experiment.createBinding(1, { width: 640, height: 360 }, 1);
    const firstCreation = createNativeFoundationSceneCreation(
      firstDevice.device,
      'bgra8unorm',
      firstSource,
    );
    await vi.waitFor(() => expect(firstDevice.createPipeline).toHaveBeenCalledOnce());
    firstSource.detach();
    pendingPipeline.resolve(firstPipeline);
    await expect(firstCreation.result).rejects.toThrow('detached');
    experiment.abortAttempt(1);

    const secondPipeline = { label: 'retry' } as GPURenderPipeline;
    const secondDevice = nativeDevice({
      createPipeline: () => Promise.resolve(secondPipeline),
    });
    const second = await createScene(secondDevice, experiment);
    expect(experiment.snapshot().allocations.positions).toBe(allocations.positions);
    expect(experiment.snapshot().allocations.colors).toBe(allocations.colors);
    second.scene.render(canvasContext());
    expect(secondDevice.passSetPipeline).toHaveBeenCalledWith(secondPipeline);
    expect(secondDevice.passSetPipeline).not.toHaveBeenCalledWith(firstPipeline);
    expect(firstDevice.bufferDestroy).toHaveBeenCalledOnce();
    expect(secondDevice.createPipeline).toHaveBeenCalledOnce();

    second.scene.dispose();
    experiment.dispose();
  });
});

describe('native foundation partial creation cleanup', () => {
  it.each(['buffer', 'position-write', 'color-write', 'shader'] as const)(
    'cleans up a synchronous %s failure',
    async (failAt) => {
      const fixture = nativeDevice({ failAt });
      const experiment = new FoundationExperiment(1);
      const source = experiment.createBinding(1, { width: 640, height: 360 }, 1);
      const creation = createNativeFoundationSceneCreation(fixture.device, 'bgra8unorm', source);

      await expect(creation.result).rejects.toThrow();
      const snapshot = experiment.snapshot();
      expect(snapshot).toMatchObject({
        pendingNativeCreations: 0,
        liveBackingBuffers: 0,
        livePipelines: 0,
      });
      expect(snapshot.bindingGeneration).toBeUndefined();
      if (failAt === 'buffer') expect(fixture.bufferDestroy).not.toHaveBeenCalled();
      else expect(fixture.bufferDestroy).toHaveBeenCalledOnce();
      experiment.abortAttempt(1);
      experiment.dispose();
    },
  );

  it('releases the buffer promptly when disposed during pending pipeline creation', async () => {
    const pendingPipeline = deferred<GPURenderPipeline>();
    const fixture = nativeDevice({ createPipeline: () => pendingPipeline.promise });
    const experiment = new FoundationExperiment(1);
    const source = experiment.createBinding(1, { width: 640, height: 360 }, 1);
    const creation = createNativeFoundationSceneCreation(fixture.device, 'bgra8unorm', source);
    await vi.waitFor(() => expect(fixture.createPipeline).toHaveBeenCalledOnce());

    creation.dispose();
    expect(fixture.bufferDestroy).toHaveBeenCalledOnce();
    expect(experiment.snapshot()).toMatchObject({
      pendingNativeCreations: 1,
      liveBackingBuffers: 0,
    });

    experiment.dispose();
    expect(experiment.snapshot()).toMatchObject({
      disposed: true,
      pendingNativeCreations: 1,
      liveBackingBuffers: 0,
      livePipelines: 0,
      allocator: { liveAllocationCount: 0, reservedBytes: 0 },
    });
    pendingPipeline.resolve({ label: 'late-pipeline' } as GPURenderPipeline);
    await expect(creation.result).rejects.toThrow();
    expect(experiment.snapshot()).toMatchObject({
      pendingNativeCreations: 0,
      liveBackingBuffers: 0,
      livePipelines: 0,
      allocator: { liveAllocationCount: 0, reservedBytes: 0 },
    });
  });

  it('releases the buffer and binding when both pipeline sample counts fail', async () => {
    const fixture = nativeDevice({
      createPipeline: (descriptor) =>
        Promise.reject(new Error(`${descriptor.multisample?.count ?? 1}x failed`)),
    });
    const experiment = new FoundationExperiment(1);
    const source = experiment.createBinding(1, { width: 640, height: 360 }, 1);
    const creation = createNativeFoundationSceneCreation(fixture.device, 'bgra8unorm', source);

    await expect(creation.result).rejects.toThrow('1x failed');
    expect(fixture.createPipeline).toHaveBeenCalledTimes(2);
    expect(fixture.bufferDestroy).toHaveBeenCalledOnce();
    expect(experiment.snapshot()).toMatchObject({
      pendingNativeCreations: 0,
      liveBackingBuffers: 0,
      livePipelines: 0,
      cache: { pendingEntries: 0, readyEntries: 0 },
    });
    experiment.abortAttempt(1);
    experiment.dispose();
  });
});
