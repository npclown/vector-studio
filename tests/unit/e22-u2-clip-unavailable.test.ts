import type { RendererDiagnostic } from '@vector-studio/contracts';
import { DIAGNOSTIC_CODES } from '@vector-studio/contracts';
import { PrimitiveRendererService } from '@vector-studio/renderer-core';
import {
  WebGpuBackend,
  type WebGpuAdapterPort,
  type WebGpuDevicePort,
  type WebGpuPlatform,
  type WebGpuPrimitiveScenePort,
} from '@vector-studio/renderer-webgpu';
import { describe, expect, it, vi } from 'vitest';

import {
  PipelineCache,
  type PipelineCacheSnapshot,
} from '../../packages/renderer-webgpu/src/pipeline-cache.js';
import { primitivePipelineKey } from '../../packages/renderer-webgpu/src/primitive-pipeline.js';
import { nativeFixture, nativeScene } from '../support/p4-native-fixture.js';

// E22 contract (docs/plans/d9-e22-clip-follow-ups-contract.md), unit U2: the
// `render.clip-unavailable` diagnostic (E22-K4, A7) and no cached clip variant after a failed
// variant step (E22-K5, A8).

function fakeDevice(clipPipelineAvailable: boolean) {
  const scene: WebGpuPrimitiveScenePort = {
    sampleCount: 4,
    shaderModulesCreated: 1,
    pipelinesCreated: 1,
    meshPipelineAvailable: false,
    clipPipelineAvailable,
    setTarget: vi.fn(),
    submitPrimitivePacket: vi.fn(() => ({ status: 'not-ready' as const })),
    dispose: vi.fn(),
  };
  const createPrimitiveScene = vi.fn(() => ({
    result: Promise.resolve({ scene, fellBackFrom4x: false }),
    dispose: () => scene.dispose(),
  }));
  let lose!: (loss: { reason: 'unknown'; message: string }) => void;
  const device: WebGpuDevicePort = {
    features: [],
    limits: { maxTextureDimension2D: 4096, maxBufferSize: 256 * 1024 * 1024 },
    lost: new Promise((resolve) => {
      lose = resolve;
    }),
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
  return {
    adapter,
    createPrimitiveScene,
    lose: (message: string) => lose({ reason: 'unknown', message }),
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

const surface = {
  canvas: { width: 0, height: 0 } as HTMLCanvasElement,
  cssSize: { width: 640, height: 360 },
  devicePixelRatio: 1,
};

const unavailable = (diagnostics: readonly RendererDiagnostic[]) =>
  diagnostics.filter((diagnostic) => diagnostic.code === DIAGNOSTIC_CODES.CLIP_UNAVAILABLE);

async function start(clips: 'none' | 'rect' | 'all', devices: ReturnType<typeof fakeDevice>[]) {
  const backend = new WebGpuBackend({ platform: platformFor(devices.map((d) => d.adapter)) });
  const diagnostics: RendererDiagnostic[] = [];
  backend.subscribeDiagnostics((diagnostic) => diagnostics.push(diagnostic));
  const invalidate = { invalidate: vi.fn(), setMode: vi.fn() };
  const service = new PrimitiveRendererService(invalidate, { clips });
  backend.attachPrimitiveFrameSource(service);
  await backend.initialize(surface);
  return { backend, diagnostics, service };
}

describe('E22-K4 render.clip-unavailable (E22-A7)', () => {
  it('is emitted once per generation when clips are required and the variants are unavailable', async () => {
    const first = fakeDevice(false);
    const second = fakeDevice(false);
    const { backend, diagnostics, service } = await start('all', [first, second]);
    expect(unavailable(diagnostics)).toHaveLength(1);
    expect(unavailable(diagnostics)[0]).toMatchObject({ severity: 'warning', generation: 1 });
    first.lose('injected loss');
    await vi.waitFor(() => {
      expect(backend.generation).toBe(2);
      expect(backend.state).toBe('ready');
    });
    expect(unavailable(diagnostics).map((diagnostic) => diagnostic.generation)).toEqual([1, 2]);
    backend.dispose();
    service.dispose();
  });

  it('is not emitted when the variants are available or clips are not required', async () => {
    for (const [clips, available] of [
      ['rect', true],
      ['all', true],
      ['none', false],
    ] as const) {
      const { backend, diagnostics, service } = await start(clips, [fakeDevice(available)]);
      expect(backend.state).toBe('ready');
      expect(unavailable(diagnostics)).toEqual([]);
      backend.dispose();
      service.dispose();
    }
  });

  it('a test-hook backend still fails the generation instead', async () => {
    const device = fakeDevice(false);
    const backend = new WebGpuBackend({
      platform: platformFor([device.adapter]),
      sampleCountForTesting: 4,
    });
    const diagnostics: RendererDiagnostic[] = [];
    backend.subscribeDiagnostics((diagnostic) => diagnostics.push(diagnostic));
    const service = new PrimitiveRendererService(
      { invalidate: vi.fn(), setMode: vi.fn() },
      { clips: 'all' },
    );
    backend.attachPrimitiveFrameSource(service);
    const result = await backend.initialize(surface);
    expect(result.supported).toBe(false);
    expect(unavailable(diagnostics)).toEqual([]);
    expect(diagnostics.map((diagnostic) => diagnostic.code)).toContain(
      DIAGNOSTIC_CODES.FOUNDATION_SCENE_FAILED,
    );
    backend.dispose();
    service.dispose();
  });
});

/** The scene's pipeline cache counts (the native scene's test seam). */
const readyOf = (scene: unknown) =>
  (
    scene as { pipelineCacheSnapshotForTesting(): PipelineCacheSnapshot }
  ).pipelineCacheSnapshotForTesting();

describe('E22-K5 no cached clip variant after a failed step (E22-A8)', () => {
  it('PipelineCache.evict removes and releases a ready entry and invalidates a pending one', async () => {
    const release = vi.fn();
    const cache = new PipelineCache<string>(1, { release });
    const key = primitivePipelineKey('bgra8unorm', 4);
    await cache.getOrCreate(key, () => 'ready');
    cache.evict(key);
    expect(release).toHaveBeenCalledWith('ready');
    expect(cache.snapshot().readyEntries).toBe(0);
    // Evicted before its factory starts: the creation is invalidated.
    const early = cache.getOrCreate(key, () => 'never');
    cache.evict(key);
    expect(cache.snapshot().pendingEntries).toBe(0);
    await expect(early).rejects.toThrow('invalidated before it started');
    // Evicted while its factory runs: the late value is released and the promise rejects.
    let finish!: (value: string) => void;
    const running = cache.getOrCreate(
      key,
      () =>
        new Promise<string>((resolve) => {
          finish = resolve;
        }),
    );
    await vi.waitFor(() => expect(finish).toBeDefined());
    cache.evict(key);
    finish('late');
    await expect(running).rejects.toThrow('evicted');
    expect(release).toHaveBeenCalledWith('late');
    expect(cache.snapshot().readyEntries).toBe(0);
    cache.evict(key);
  });

  const steps: readonly (readonly [string, { failPipeline?: string; failTexture?: string }])[] = [
    // Nothing is cached before the analytic variant, so this case holds without eviction too;
    // the five after it exercise E22-K5.
    ['analytic', { failPipeline: 'primitive-stencil-4x+clip' }],
    ['mask analytic', { failPipeline: 'primitive-4x+mask' }],
    ['default mask', { failTexture: 'clip-default-mask' }],
    ['mesh', { failPipeline: 'p3-mesh-fill-4x+clip' }],
    ['mesh joint', { failPipeline: 'p3-mesh-joint-4x+clip' }],
    ['mesh mask', { failPipeline: 'p3-mesh-fill-4x+mask' }],
  ];

  it.each(steps)(
    'a %s failure leaves the cache and accounting as without clips',
    async (_, failure) => {
      const plain = await nativeScene(nativeFixture(), { meshPipeline: true });
      const baseline = readyOf(plain.scene).readyEntries;
      const baselineLive = plain.accounting.snapshot().live;
      plain.creation.dispose();
      const fixture = nativeFixture(
        failure.failPipeline === undefined ? {} : { failPipeline: failure.failPipeline },
      );
      if (failure.failTexture !== undefined) {
        const device = fixture.device as unknown as {
          createTexture: ReturnType<typeof vi.fn<(descriptor: GPUTextureDescriptor) => unknown>>;
        };
        const create = device.createTexture.getMockImplementation()!;
        device.createTexture.mockImplementation((descriptor) => {
          if (descriptor.label?.endsWith(failure.failTexture!)) throw new Error('injected');
          return create(descriptor);
        });
      }
      const { scene, creation, accounting } = await nativeScene(fixture);
      expect(scene.clipPipelineAvailable).toBe(false);
      expect(readyOf(scene).readyEntries).toBe(baseline);
      expect(accounting.snapshot().live).toBe(baselineLive);
      creation.dispose();
      expect(accounting.snapshot().live).toBe(0);
    },
  );
});
