import { DIAGNOSTIC_CODES, type RendererDiagnostic } from '@vector-studio/contracts';
import {
  WebGpuBackend,
  type WebGpuAdapterPort,
  type WebGpuCanvasContextPort,
  type WebGpuDevicePort,
  type WebGpuDeviceError,
  type WebGpuDeviceLoss,
  type WebGpuFoundationScenePort,
  type WebGpuPlatform,
  type WebGpuSurface,
} from '@vector-studio/renderer-webgpu';
import { describe, expect, it, vi } from 'vitest';
import type { AnimationFrameClock } from '@vector-studio/renderer-core';

class ManualAnimationFrameClock implements AnimationFrameClock {
  readonly callbacks = new Map<number, (timestampMs: number) => void>();
  #nextHandle = 1;

  request(callback: (timestampMs: number) => void): number {
    const handle = this.#nextHandle++;
    this.callbacks.set(handle, callback);
    return handle;
  }

  cancel(handle: number): void {
    this.callbacks.delete(handle);
  }

  flush(timestampMs = 16): void {
    const callbacks = [...this.callbacks.values()];
    this.callbacks.clear();
    for (const callback of callbacks) callback(timestampMs);
  }
}

interface Deferred<Value> {
  readonly promise: Promise<Value>;
  resolve(value: Value): void;
}

function deferred<Value>(): Deferred<Value> {
  let resolvePromise: ((value: Value) => void) | undefined;
  const promise = new Promise<Value>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve: (value) => resolvePromise?.(value),
  };
}

function fakeCanvas(): HTMLCanvasElement {
  return { width: 0, height: 0 } as HTMLCanvasElement;
}

function surface(canvas = fakeCanvas()): WebGpuSurface {
  return { canvas, cssSize: { width: 640, height: 360 }, devicePixelRatio: 1 };
}

interface FakeDeviceController {
  readonly destroy: ReturnType<typeof vi.fn>;
  readonly device: WebGpuDevicePort;
  readonly render: ReturnType<typeof vi.fn>;
  readonly scene: WebGpuFoundationScenePort;
  readonly sceneDispose: ReturnType<typeof vi.fn>;
  readonly waitForSubmittedWork: ReturnType<typeof vi.fn>;
  emitError(error: WebGpuDeviceError): void;
  lose(loss?: WebGpuDeviceLoss): void;
  listenerCount(): number;
}

function fakeDeviceController(): FakeDeviceController {
  const render = vi.fn();
  const sceneDispose = vi.fn();
  const loss = deferred<WebGpuDeviceLoss>();
  const destroy = vi.fn(() =>
    loss.resolve({ reason: 'destroyed', message: 'test device destroyed' }),
  );
  const waitForSubmittedWork = vi.fn(() => Promise.resolve());
  const errorListeners = new Set<(error: WebGpuDeviceError) => void>();
  let attachmentBytes = 0;
  const scene: WebGpuFoundationScenePort = {
    sampleCount: 4,
    shaderModulesCreated: 1,
    pipelinesCreated: 1,
    staticResources: [
      { id: 'foundation-vertices', descriptor: { category: 'buffer', size: 60 } },
      { id: 'foundation-shader', descriptor: { category: 'shader-module' } },
      { id: 'foundation-pipeline', descriptor: { category: 'render-pipeline' } },
    ],
    get attachmentBytes() {
      return attachmentBytes;
    },
    resize: (size) => {
      attachmentBytes = size.width * size.height * 4 * 4;
    },
    render,
    dispose: sceneDispose,
  };
  const device: WebGpuDevicePort = {
    features: ['timestamp-query'],
    limits: { maxTextureDimension2D: 4096, maxBufferSize: 268_435_456 },
    lost: loss.promise,
    createFoundationScene: () => Promise.resolve({ scene, fellBackFrom4x: false }),
    waitForSubmittedWork,
    subscribeErrors: (listener) => {
      let disposed = false;
      errorListeners.add(listener);
      return {
        get disposed() {
          return disposed;
        },
        dispose: () => {
          if (disposed) return;
          disposed = true;
          errorListeners.delete(listener);
        },
      };
    },
    triggerValidationErrorForTesting: vi.fn(),
    destroy,
  };
  return {
    destroy,
    device,
    render,
    scene,
    sceneDispose,
    waitForSubmittedWork,
    emitError: (error) => {
      for (const listener of errorListeners) listener(error);
    },
    lose: (deviceLoss = { reason: 'destroyed', message: 'test device loss' }) =>
      loss.resolve(deviceLoss),
    listenerCount: () => errorListeners.size,
  };
}

function fixture(): {
  adapter: WebGpuAdapterPort;
  configure: ReturnType<typeof vi.fn>;
  context: WebGpuCanvasContextPort;
  destroy: ReturnType<typeof vi.fn>;
  device: WebGpuDevicePort;
  platform: WebGpuPlatform;
  requestAdapter: ReturnType<typeof vi.fn>;
  requestDevice: ReturnType<typeof vi.fn>;
  unconfigure: ReturnType<typeof vi.fn>;
  scene: WebGpuFoundationScenePort;
  render: ReturnType<typeof vi.fn>;
  controller: FakeDeviceController;
} {
  const controller = fakeDeviceController();
  const { destroy, device, render, scene } = controller;
  const requestDevice = vi.fn(() => Promise.resolve(device));
  const adapter: WebGpuAdapterPort = {
    info: { vendor: 'test-vendor', architecture: 'test-architecture' },
    requestDevice,
  };
  const configure = vi.fn();
  const unconfigure = vi.fn();
  const context: WebGpuCanvasContextPort = { configure, unconfigure };
  const requestAdapter = vi.fn(() => Promise.resolve(adapter));
  const platform: WebGpuPlatform = {
    secureContext: true,
    apiAvailable: true,
    requestAdapter,
    getCanvasContext: () => context,
    getPreferredCanvasFormat: () => 'bgra8unorm',
  };
  return {
    adapter,
    configure,
    context,
    destroy,
    device,
    platform,
    requestAdapter,
    requestDevice,
    unconfigure,
    scene,
    render,
    controller,
  };
}

async function expectFailure(
  backend: WebGpuBackend,
  expectedCode: string,
): Promise<RendererDiagnostic> {
  const result = await backend.initialize(surface());
  expect(result.supported).toBe(false);
  if (result.supported) {
    throw new Error('Expected initialization failure.');
  }
  expect(result.diagnostic.code).toBe(expectedCode);
  return result.diagnostic;
}

describe('WebGpuBackend capability detection', () => {
  it('reports insecure context separately', async () => {
    const { platform, requestAdapter } = fixture();
    const backend = new WebGpuBackend({ platform: { ...platform, secureContext: false } });

    await expectFailure(backend, DIAGNOSTIC_CODES.INSECURE_CONTEXT);
    expect(backend.state).toBe('unsupported');
    expect(requestAdapter).not.toHaveBeenCalled();
  });

  it('reports missing API separately', async () => {
    const { platform } = fixture();
    const backend = new WebGpuBackend({ platform: { ...platform, apiAvailable: false } });
    await expectFailure(backend, DIAGNOSTIC_CODES.API_UNAVAILABLE);
  });

  it('reports missing canvas context separately', async () => {
    const { platform } = fixture();
    const backend = new WebGpuBackend({
      platform: { ...platform, getCanvasContext: () => null },
    });
    await expectFailure(backend, DIAGNOSTIC_CODES.CANVAS_CONTEXT_UNAVAILABLE);
  });

  it('reports unavailable and rejected adapters separately', async () => {
    const { platform } = fixture();
    const unavailable = new WebGpuBackend({
      platform: { ...platform, requestAdapter: () => Promise.resolve(null) },
    });
    await expectFailure(unavailable, DIAGNOSTIC_CODES.ADAPTER_UNAVAILABLE);

    const rejected = new WebGpuBackend({
      platform: {
        ...platform,
        requestAdapter: () => Promise.reject(new Error('adapter rejected')),
      },
    });
    const diagnostic = await expectFailure(rejected, DIAGNOSTIC_CODES.ADAPTER_REQUEST_FAILED);
    expect(diagnostic.context).toEqual({
      errorName: 'Error',
      errorMessage: 'adapter rejected',
    });
  });

  it('reports device-request and canvas-configuration failures separately', async () => {
    const { adapter, platform } = fixture();
    const deviceFailure = new WebGpuBackend({
      platform: {
        ...platform,
        requestAdapter: () =>
          Promise.resolve({
            ...adapter,
            requestDevice: () => Promise.reject(new Error('device rejected')),
          }),
      },
    });
    await expectFailure(deviceFailure, DIAGNOSTIC_CODES.DEVICE_REQUEST_FAILED);

    const { destroy, platform: configurePlatform } = fixture();
    const configureFailure = new WebGpuBackend({
      platform: {
        ...configurePlatform,
        getCanvasContext: () => ({
          configure: () => {
            throw new Error('configure rejected');
          },
          unconfigure: vi.fn(),
        }),
      },
    });
    await expectFailure(configureFailure, DIAGNOSTIC_CODES.SURFACE_CONFIGURATION_FAILED);
    expect(destroy).toHaveBeenCalledOnce();
  });
});

describe('WebGpuBackend lifecycle and surface', () => {
  it('records device capabilities, configures the surface, and is idempotent while ready', async () => {
    const { configure, platform, requestAdapter, requestDevice } = fixture();
    const canvas = fakeCanvas();
    const backend = new WebGpuBackend({ platform });

    const first = await backend.initialize(surface(canvas));
    const second = await backend.initialize(surface(canvas));

    expect(first).toBe(second);
    expect(first).toMatchObject({
      supported: true,
      capabilities: {
        backend: 'webgpu',
        adapter: { vendor: 'test-vendor', architecture: 'test-architecture' },
        selectedFeatures: ['timestamp-query'],
        limits: { maxTextureDimension2D: 4096, maxBufferSize: 268_435_456 },
        sampleCount: 4,
      },
    });
    expect(backend.state).toBe('ready');
    expect(backend.generation).toBe(1);
    expect(backend.presentationFormat).toBe('bgra8unorm');
    expect(canvas).toMatchObject({ width: 640, height: 360 });
    expect(configure).toHaveBeenCalledOnce();
    expect(requestAdapter).toHaveBeenCalledOnce();
    expect(requestDevice).toHaveBeenCalledOnce();
    await expect(backend.waitForSubmittedWork()).resolves.toBeUndefined();
  });

  it('shares one concurrent initialization attempt', async () => {
    const { adapter, platform, requestAdapter } = fixture();
    const deviceRequest = deferred<WebGpuDevicePort>();
    const requestDevice = vi.fn(() => deviceRequest.promise);
    const backend = new WebGpuBackend({
      platform: {
        ...platform,
        requestAdapter: () => Promise.resolve({ ...adapter, requestDevice }),
      },
    });

    const first = backend.initialize(surface());
    const second = backend.initialize(surface());
    expect(first).toBe(second);

    const { device } = fixture();
    deviceRequest.resolve(device);
    await expect(first).resolves.toMatchObject({ supported: true });
    expect(requestAdapter).not.toHaveBeenCalled();
    expect(requestDevice).toHaveBeenCalledOnce();
  });

  it('cannot be revived by stale device completion after disposal', async () => {
    const { adapter, destroy, device, platform, unconfigure } = fixture();
    const deviceRequest = deferred<WebGpuDevicePort>();
    const backend = new WebGpuBackend({
      platform: {
        ...platform,
        requestAdapter: () =>
          Promise.resolve({ ...adapter, requestDevice: () => deviceRequest.promise }),
      },
    });

    const initialization = backend.initialize(surface());
    await Promise.resolve();
    backend.dispose();
    backend.dispose();
    deviceRequest.resolve(device);

    await expect(initialization).resolves.toMatchObject({
      supported: false,
      diagnostic: { code: DIAGNOSTIC_CODES.STALE_INITIALIZATION_IGNORED },
    });
    expect(backend.state).toBe('disposed');
    await expect(backend.waitForSubmittedWork()).rejects.toThrow(
      'The backend must be ready before waiting for GPU work.',
    );
    expect(destroy).toHaveBeenCalledOnce();
    expect(unconfigure).not.toHaveBeenCalled();
    await expectFailure(backend, DIAGNOSTIC_CODES.INITIALIZATION_AFTER_DISPOSE);
  });

  it('resizes with DPR and clamping without recreating size-independent state', async () => {
    const { configure, platform, requestAdapter, requestDevice } = fixture();
    const canvas = fakeCanvas();
    const backend = new WebGpuBackend({ platform });
    await backend.initialize(surface(canvas));

    expect(backend.resize({ width: 3000, height: 100 }, 2)).toMatchObject({
      physical: { width: 4096, height: 200 },
      suspended: false,
    });
    expect(backend.surfaceRevision).toBe(2);
    backend.resize({ width: 3000, height: 100 }, 2);
    expect(backend.surfaceRevision).toBe(2);
    expect(backend.resize({ width: 0, height: 100 }, 2)).toMatchObject({
      physical: { width: 0, height: 200 },
      suspended: true,
    });
    expect(backend.state).toBe('ready');
    expect(configure).toHaveBeenCalledOnce();
    expect(requestAdapter).toHaveBeenCalledOnce();
    expect(requestDevice).toHaveBeenCalledOnce();
    expect(backend.getStatistics().resources).toMatchObject({
      live: 3,
      byCategory: {
        buffer: { live: 1 },
        texture: { created: 2, live: 0 },
        'shader-module': { live: 1 },
        'render-pipeline': { live: 1 },
      },
    });
  });

  it('coalesces backend invalidations and leaves pipeline creation outside frame submission', async () => {
    const { platform, render } = fixture();
    const animationFrameClock = new ManualAnimationFrameClock();
    const backend = new WebGpuBackend({ platform, animationFrameClock, now: () => 1 });
    await backend.initialize(surface());

    for (let index = 0; index < 100; index += 1) {
      backend.invalidate({ reason: 'scene' });
    }

    expect(animationFrameClock.callbacks).toHaveLength(1);
    expect(backend.getStatistics()).toMatchObject({
      invalidationsRequested: 101,
      pendingFrameCallbacks: 1,
      pipelinesCreated: 1,
      shaderModulesCreated: 1,
    });
    animationFrameClock.flush();
    expect(render).toHaveBeenCalledOnce();
    expect(backend.getStatistics()).toMatchObject({
      framesSubmitted: 1,
      framesPresented: 1,
      pendingFrameCallbacks: 0,
      pipelinesCreated: 1,
      shaderModulesCreated: 1,
    });
    animationFrameClock.flush(32);
    expect(render).toHaveBeenCalledOnce();
    expect(backend.getFrameMeasurements()).toMatchObject({
      active: false,
      encodeAndSubmitMs: [],
      frameIntervalsMs: [],
    });
  });

  it('collects only explicit bounded measurement windows and clears them on reset or dispose', async () => {
    const { platform } = fixture();
    const animationFrameClock = new ManualAnimationFrameClock();
    let nowMs = 0;
    const backend = new WebGpuBackend({
      platform,
      animationFrameClock,
      now: () => nowMs++,
    });
    await backend.initialize(surface());
    animationFrameClock.flush(0);

    expect(() => backend.startFrameMeasurements(0)).toThrow(RangeError);
    backend.startFrameMeasurements(2);
    backend.setMode('continuous');
    animationFrameClock.flush(16);
    animationFrameClock.flush(32);
    animationFrameClock.flush(48);
    animationFrameClock.flush(64);
    backend.setMode('on-demand');

    expect(backend.stopFrameMeasurements()).toMatchObject({
      active: false,
      capacity: 2,
      startedAtMs: 1,
      endedAtMs: 8,
      encodeAndSubmitMs: [1, 1],
      frameIntervalsMs: [16, 16],
      droppedSamples: { encodeAndSubmitMs: 2, frameIntervalsMs: 1 },
    });
    animationFrameClock.flush(80);
    expect(backend.getFrameMeasurements().encodeAndSubmitMs).toHaveLength(2);

    backend.resetFrameMeasurements();
    expect(backend.getFrameMeasurements()).toMatchObject({
      active: false,
      capacity: 4096,
      encodeAndSubmitMs: [],
      frameIntervalsMs: [],
      droppedSamples: { encodeAndSubmitMs: 0, frameIntervalsMs: 0 },
    });

    backend.startFrameMeasurements();
    backend.dispose();
    expect(backend.getFrameMeasurements()).toMatchObject({
      active: false,
      encodeAndSubmitMs: [],
      frameIntervalsMs: [],
    });
  });

  it('records the explicit 4x to 1x MSAA fallback', async () => {
    const { device, platform, scene } = fixture();
    const diagnostics: RendererDiagnostic[] = [];
    const oneSampleScene: WebGpuFoundationScenePort = {
      ...scene,
      sampleCount: 1,
      pipelinesCreated: 1,
    };
    const backend = new WebGpuBackend({
      platform: {
        ...platform,
        requestAdapter: () =>
          Promise.resolve({
            info: {},
            requestDevice: () =>
              Promise.resolve({
                ...device,
                createFoundationScene: () =>
                  Promise.resolve({ scene: oneSampleScene, fellBackFrom4x: true }),
              }),
          }),
      },
    });
    backend.subscribeDiagnostics((diagnostic) => diagnostics.push(diagnostic));

    await expect(backend.initialize(surface())).resolves.toMatchObject({
      supported: true,
      capabilities: { sampleCount: 1 },
    });
    expect(diagnostics).toContainEqual(
      expect.objectContaining({
        code: DIAGNOSTIC_CODES.MSAA_FALLBACK,
        context: { requestedSampleCount: 4, selectedSampleCount: 1 },
      }),
    );
    expect(backend.getStatistics()).toMatchObject({
      pipelinesCreated: 1,
      shaderModulesCreated: 1,
    });
  });

  it('maps uncaptured validation and out-of-memory errors with generation context', async () => {
    const { controller, platform } = fixture();
    const diagnostics: RendererDiagnostic[] = [];
    const backend = new WebGpuBackend({ platform });
    backend.subscribeDiagnostics((diagnostic) => diagnostics.push(diagnostic));
    await backend.initialize(surface());

    controller.emitError({ type: 'validation', message: 'invalid binding' });
    controller.emitError({ type: 'out-of-memory', message: 'allocation rejected' });
    controller.emitError({ type: 'internal', message: 'driver failure' });

    expect(diagnostics.slice(-3)).toMatchObject([
      {
        code: DIAGNOSTIC_CODES.VALIDATION_ERROR,
        generation: 1,
        context: { errorType: 'validation', errorMessage: 'invalid binding' },
      },
      {
        code: DIAGNOSTIC_CODES.OUT_OF_MEMORY,
        generation: 1,
        context: { errorType: 'out-of-memory', errorMessage: 'allocation rejected' },
      },
      {
        code: DIAGNOSTIC_CODES.RENDER_SUBMISSION_FAILED,
        generation: 1,
        context: { errorType: 'internal', errorMessage: 'driver failure' },
      },
    ]);
  });

  it('pauses the lost generation and performs one ordered recovery from CPU descriptors', async () => {
    const first = fakeDeviceController();
    const second = fakeDeviceController();
    const recoveredDevice = deferred<WebGpuDevicePort>();
    const configure = vi.fn();
    const unconfigure = vi.fn();
    const context: WebGpuCanvasContextPort = { configure, unconfigure };
    const requestAdapter = vi
      .fn<() => Promise<WebGpuAdapterPort | null>>()
      .mockResolvedValueOnce({
        info: { vendor: 'first' },
        requestDevice: () => Promise.resolve(first.device),
      })
      .mockResolvedValueOnce({
        info: { vendor: 'second' },
        requestDevice: () => recoveredDevice.promise,
      });
    const platform: WebGpuPlatform = {
      secureContext: true,
      apiAvailable: true,
      requestAdapter,
      getCanvasContext: () => context,
      getPreferredCanvasFormat: () => 'bgra8unorm',
    };
    const animationFrameClock = new ManualAnimationFrameClock();
    const diagnostics: RendererDiagnostic[] = [];
    const backend = new WebGpuBackend({ platform, animationFrameClock });
    backend.subscribeDiagnostics((diagnostic) => diagnostics.push(diagnostic));
    await backend.initialize(surface());
    animationFrameClock.flush();
    const presentedBeforeLoss = backend.getStatistics().framesPresented;

    first.lose({ reason: 'destroyed', message: 'deliberate test loss' });
    await vi.waitFor(() => expect(backend.getStatistics().recoveryAttempts).toBe(1));
    const sharedRecovery = backend.initialize(surface());
    expect(backend.initialize(surface())).toBe(sharedRecovery);
    expect(requestAdapter).toHaveBeenCalledTimes(2);
    backend.invalidate({ reason: 'scene' });
    backend.setMode('continuous');
    backend.invalidate({ reason: 'viewport' });
    expect(animationFrameClock.callbacks).toHaveLength(0);
    expect(first.render).toHaveBeenCalledOnce();
    recoveredDevice.resolve(second.device);
    await expect(sharedRecovery).resolves.toMatchObject({ supported: true });
    await vi.waitFor(() => expect(backend.state).toBe('ready'));

    expect(backend.generation).toBe(2);
    expect(requestAdapter).toHaveBeenCalledTimes(2);
    expect(configure).toHaveBeenCalledTimes(2);
    expect(unconfigure).toHaveBeenCalledOnce();
    expect(first.sceneDispose).toHaveBeenCalledOnce();
    expect(first.listenerCount()).toBe(0);
    expect(second.listenerCount()).toBe(1);
    expect(backend.getStatistics()).toMatchObject({
      recoveryAttempts: 1,
      staleGenerationSubmissions: 0,
      pendingFrameCallbacks: 1,
      resources: { live: 4 },
    });
    const recoveryCodes: readonly string[] = [
      DIAGNOSTIC_CODES.DEVICE_LOST,
      DIAGNOSTIC_CODES.RECOVERY_STARTED,
      DIAGNOSTIC_CODES.RECOVERY_SUCCEEDED,
    ];
    expect(
      diagnostics
        .filter((diagnostic) => recoveryCodes.includes(diagnostic.code))
        .map(({ code, generation }) => ({ code, generation })),
    ).toEqual([
      { code: DIAGNOSTIC_CODES.DEVICE_LOST, generation: 1 },
      { code: DIAGNOSTIC_CODES.RECOVERY_STARTED, generation: 2 },
      { code: DIAGNOSTIC_CODES.RECOVERY_SUCCEEDED, generation: 2 },
    ]);

    animationFrameClock.flush(32);
    expect(backend.getStatistics().framesPresented).toBe(presentedBeforeLoss + 1);
    expect(second.render).toHaveBeenCalledOnce();
    expect(first.render).toHaveBeenCalledOnce();
  });

  it('keeps recovery failure terminal for one instance while a new instance can initialize', async () => {
    const { adapter, controller, platform } = fixture();
    let adapterRequest = 0;
    const requestAdapter = vi.fn(() => Promise.resolve(adapterRequest++ === 0 ? adapter : null));
    const diagnostics: RendererDiagnostic[] = [];
    const backend = new WebGpuBackend({ platform: { ...platform, requestAdapter } });
    backend.subscribeDiagnostics((diagnostic) => diagnostics.push(diagnostic));
    await backend.initialize(surface());

    controller.lose();
    await vi.waitFor(() => expect(backend.getStatistics().recoveryAttempts).toBe(1));
    await vi.waitFor(() => expect(backend.state).toBe('failed'));

    expect(requestAdapter).toHaveBeenCalledTimes(2);
    expect(backend.getStatistics()).toMatchObject({ recoveryAttempts: 1, resources: { live: 0 } });
    expect(
      diagnostics.filter(({ code }) => code === DIAGNOSTIC_CODES.RECOVERY_FAILED),
    ).toHaveLength(1);

    const retryResults = await Promise.all([
      backend.initialize(surface()),
      backend.initialize(surface()),
      backend.initialize(surface()),
    ]);
    expect(retryResults.every((result) => result === retryResults[0])).toBe(true);
    expect(retryResults[0]).toMatchObject({ supported: false });
    expect(requestAdapter).toHaveBeenCalledTimes(2);
    expect(backend.state).toBe('failed');

    backend.dispose();
    backend.dispose();
    expect(backend.state).toBe('disposed');

    const fresh = fixture();
    const replacement = new WebGpuBackend({ platform: fresh.platform });
    await expect(replacement.initialize(surface())).resolves.toMatchObject({ supported: true });
    expect(fresh.requestAdapter).toHaveBeenCalledOnce();
    replacement.dispose();
  });

  it('does not revive or submit when disposal wins a pending recovery race', async () => {
    const first = fakeDeviceController();
    const second = fakeDeviceController();
    const recoveredDevice = deferred<WebGpuDevicePort>();
    const requestAdapter = vi
      .fn<() => Promise<WebGpuAdapterPort | null>>()
      .mockResolvedValueOnce({
        info: { vendor: 'first' },
        requestDevice: () => Promise.resolve(first.device),
      })
      .mockResolvedValueOnce({
        info: { vendor: 'second' },
        requestDevice: () => recoveredDevice.promise,
      });
    const base = fixture();
    const animationFrameClock = new ManualAnimationFrameClock();
    const backend = new WebGpuBackend({
      animationFrameClock,
      platform: { ...base.platform, requestAdapter },
    });
    await backend.initialize(surface());
    animationFrameClock.flush();

    first.lose();
    await vi.waitFor(() => expect(backend.getStatistics().recoveryAttempts).toBe(1));
    const pendingRecovery = backend.initialize(surface());
    backend.invalidate({ reason: 'scene' });
    backend.setMode('continuous');
    backend.dispose();
    recoveredDevice.resolve(second.device);

    await expect(pendingRecovery).resolves.toMatchObject({
      supported: false,
      diagnostic: { code: DIAGNOSTIC_CODES.STALE_INITIALIZATION_IGNORED },
    });
    expect(backend.state).toBe('disposed');
    expect(requestAdapter).toHaveBeenCalledTimes(2);
    expect(first.render).toHaveBeenCalledOnce();
    expect(second.render).not.toHaveBeenCalled();
    expect(second.destroy).toHaveBeenCalledOnce();
    expect(animationFrameClock.callbacks).toHaveLength(0);
    expect(backend.getStatistics()).toMatchObject({
      resources: { live: 0 },
      diagnosticListeners: 0,
      deviceListeners: 0,
      pendingFrameCallbacks: 0,
    });
  });

  it('shares recovery when lifecycle methods re-enter from diagnostic callbacks', async () => {
    const first = fakeDeviceController();
    const second = fakeDeviceController();
    const recoveredDevice = deferred<WebGpuDevicePort>();
    const requestAdapter = vi
      .fn<() => Promise<WebGpuAdapterPort | null>>()
      .mockResolvedValueOnce({ info: {}, requestDevice: () => Promise.resolve(first.device) })
      .mockResolvedValueOnce({ info: {}, requestDevice: () => recoveredDevice.promise });
    const base = fixture();
    const animationFrameClock = new ManualAnimationFrameClock();
    const backend = new WebGpuBackend({
      animationFrameClock,
      platform: { ...base.platform, requestAdapter },
    });
    const reentrantInitializations: Promise<unknown>[] = [];
    backend.subscribeDiagnostics((diagnostic) => {
      if (
        diagnostic.code === DIAGNOSTIC_CODES.DEVICE_LOST ||
        diagnostic.code === DIAGNOSTIC_CODES.RECOVERY_STARTED
      ) {
        reentrantInitializations.push(backend.initialize(surface()));
        backend.invalidate({ reason: 'scene' });
      }
    });
    await backend.initialize(surface());
    animationFrameClock.flush();

    first.lose();
    await vi.waitFor(() => expect(reentrantInitializations).toHaveLength(2));
    expect(reentrantInitializations[0]).toBe(reentrantInitializations[1]);
    expect(requestAdapter).toHaveBeenCalledTimes(2);
    recoveredDevice.resolve(second.device);
    await Promise.all(reentrantInitializations);
    await vi.waitFor(() => expect(backend.state).toBe('ready'));

    animationFrameClock.flush();
    expect(first.render).toHaveBeenCalledOnce();
    expect(second.render).toHaveBeenCalledOnce();
    expect(backend.getStatistics()).toMatchObject({
      recoveryAttempts: 1,
      staleGenerationSubmissions: 0,
    });
  });

  it('lets disposal from a recovery diagnostic terminate the shared attempt', async () => {
    const first = fakeDeviceController();
    const base = fixture();
    const requestAdapter = vi
      .fn<() => Promise<WebGpuAdapterPort | null>>()
      .mockResolvedValueOnce({ info: {}, requestDevice: () => Promise.resolve(first.device) });
    const backend = new WebGpuBackend({ platform: { ...base.platform, requestAdapter } });
    let sharedRecovery: Promise<unknown> | undefined;
    backend.subscribeDiagnostics((diagnostic) => {
      if (diagnostic.code === DIAGNOSTIC_CODES.DEVICE_LOST) {
        sharedRecovery = backend.initialize(surface());
      }
      if (diagnostic.code === DIAGNOSTIC_CODES.RECOVERY_STARTED) {
        backend.dispose();
        backend.dispose();
      }
    });
    await backend.initialize(surface());

    first.lose();
    await vi.waitFor(() => expect(sharedRecovery).toBeDefined());
    await expect(sharedRecovery).resolves.toMatchObject({
      supported: false,
      diagnostic: { code: DIAGNOSTIC_CODES.STALE_INITIALIZATION_IGNORED },
    });
    expect(backend.state).toBe('disposed');
    expect(requestAdapter).toHaveBeenCalledOnce();
    expect(first.render).not.toHaveBeenCalled();
    expect(backend.getStatistics()).toMatchObject({
      recoveryAttempts: 1,
      resources: { live: 0 },
      diagnosticListeners: 0,
      deviceListeners: 0,
      pendingFrameCallbacks: 0,
    });
  });

  it('ignores loss completion after terminal disposal', async () => {
    const { controller, platform, requestAdapter } = fixture();
    const backend = new WebGpuBackend({ platform });
    await backend.initialize(surface());
    backend.dispose();
    controller.lose();
    await Promise.resolve();
    await Promise.resolve();

    expect(backend.state).toBe('disposed');
    expect(requestAdapter).toHaveBeenCalledOnce();
    expect(backend.getStatistics()).toMatchObject({
      recoveryAttempts: 0,
      resources: { live: 0 },
      diagnosticListeners: 0,
      deviceListeners: 0,
      pendingFrameCallbacks: 0,
    });
  });

  it('returns resources and listeners to zero across 25 lifecycle cycles', async () => {
    for (let cycle = 0; cycle < 25; cycle += 1) {
      const { controller, platform } = fixture();
      const animationFrameClock = new ManualAnimationFrameClock();
      const backend = new WebGpuBackend({ platform, animationFrameClock });
      const subscription = backend.subscribeDiagnostics(() => undefined);
      await backend.initialize(surface());
      animationFrameClock.flush();
      expect(backend.getStatistics()).toMatchObject({
        resources: { live: 4 },
        diagnosticListeners: 1,
        deviceListeners: 2,
      });

      backend.dispose();
      expect(subscription.disposed).toBe(true);
      expect(controller.listenerCount()).toBe(0);
      expect(backend.getStatistics()).toMatchObject({
        resources: { live: 0, liveBytes: 0 },
        diagnosticListeners: 0,
        deviceListeners: 0,
        pendingFrameCallbacks: 0,
      });
    }
  });
});
