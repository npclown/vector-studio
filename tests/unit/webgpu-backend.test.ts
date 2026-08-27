import { DIAGNOSTIC_CODES, type RendererDiagnostic } from '@vector-studio/contracts';
import {
  WebGpuBackend,
  type WebGpuAdapterPort,
  type WebGpuCanvasContextPort,
  type WebGpuDevicePort,
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
} {
  const destroy = vi.fn();
  const render = vi.fn();
  let attachmentBytes = 0;
  const scene: WebGpuFoundationScenePort = {
    sampleCount: 4,
    shaderModulesCreated: 1,
    pipelinesCreated: 1,
    get attachmentBytes() {
      return attachmentBytes;
    },
    resize: (size) => {
      attachmentBytes = size.width * size.height * 4 * 4;
    },
    render,
    dispose: vi.fn(),
  };
  const device: WebGpuDevicePort = {
    features: ['timestamp-query'],
    limits: { maxTextureDimension2D: 4096, maxBufferSize: 268_435_456 },
    createFoundationScene: () => Promise.resolve({ scene, fellBackFrom4x: false }),
    destroy,
  };
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
    expect(backend.getStatistics().resources.live).toBe(2);
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
});
