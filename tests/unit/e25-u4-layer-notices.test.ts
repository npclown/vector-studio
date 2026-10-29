import type { RenderNodeSnapshot, RendererDiagnostic } from '@vector-studio/contracts';
import { DIAGNOSTIC_CODES } from '@vector-studio/contracts';
import { PrimitiveRendererService } from '@vector-studio/renderer-core';
import {
  WebGpuBackend,
  type WebGpuAdapterPort,
  type WebGpuDevicePort,
  type WebGpuPlatform,
  type WebGpuPrimitiveScenePort,
} from '@vector-studio/renderer-webgpu';
import type { AnimationFrameClock } from '@vector-studio/renderer-core';
import { describe, expect, it, vi } from 'vitest';

// E25 contract (docs/plans/d9-e25-isolated-opacity-contract.md), unit U4: the backend emits the
// layers part's budget notices as `render.layer-resource-limit` (section 5), as it does P4's clip
// notices: right after a non-null prepare, before the submission checks, up to 32 per packet.
// U3 drew the layers but did not emit these; the headed O9 check needs them.

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

function fakeDevice() {
  const scene: WebGpuPrimitiveScenePort = {
    sampleCount: 4,
    shaderModulesCreated: 1,
    pipelinesCreated: 1,
    meshPipelineAvailable: false,
    clipPipelineAvailable: true,
    layerPipelineAvailable: true,
    setTarget: vi.fn(),
    submitPrimitivePacket: vi.fn(() => ({ status: 'not-ready' as const })),
    dispose: vi.fn(),
  };
  const device: WebGpuDevicePort = {
    features: [],
    limits: { maxTextureDimension2D: 8192, maxBufferSize: 256 * 1024 * 1024 },
    lost: new Promise(() => {}),
    createFoundationScene: () => {
      throw new Error('foundation mode is not used here');
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
  const adapter: WebGpuAdapterPort = { info: {}, requestDevice: () => Promise.resolve(device) };
  return adapter;
}

function platformFor(adapter: WebGpuAdapterPort): WebGpuPlatform {
  const context = { configure: vi.fn(), unconfigure: vi.fn() };
  return {
    secureContext: true,
    apiAvailable: true,
    requestAdapter: vi.fn(() => Promise.resolve(adapter)),
    getCanvasContext: vi.fn(() => context),
    getPreferredCanvasFormat: vi.fn(() => 'bgra8unorm'),
  };
}

const group = (id: string, parentId: string | null, children: string[]): RenderNodeSnapshot => ({
  id,
  parentId,
  transform: [1, 0, 0, 1, 0, 0],
  visible: true,
  opacity: 0.5,
  kind: 'container',
  clip: null,
  children,
});

const fullScreen = (id: string, parentId: string): RenderNodeSnapshot => ({
  id,
  parentId,
  transform: [1, 0, 0, 1, 0, 0],
  visible: true,
  opacity: 1,
  kind: 'primitive',
  geometry: { kind: 'rectangle', width: 3840, height: 2160, cornerRadii: [0, 0, 0, 0] },
  style: { fill: { r: 1, g: 0, b: 0, a: 1 }, stroke: null },
});

describe('E25 U4 render.layer-resource-limit from the backend (E25-A07 unit part)', () => {
  it('emits one warning on the over-budget root, on its transition, at 3840 × 2160 and 4x', async () => {
    const clock = new ManualClock();
    const backend = new WebGpuBackend({
      platform: platformFor(fakeDevice()),
      animationFrameClock: clock,
    });
    const diagnostics: RendererDiagnostic[] = [];
    backend.subscribeDiagnostics((diagnostic) => diagnostics.push(diagnostic));
    const service = new PrimitiveRendererService(backend, { clips: 'rect', groups: 'isolated' });
    backend.attachPrimitiveFrameSource(service);
    await backend.initialize({
      canvas: { width: 0, height: 0 } as HTMLCanvasElement,
      cssSize: { width: 3840, height: 2160 },
      devicePixelRatio: 1,
    });
    // Three nested full-screen layers: 3 × 33,177,600 + 25,165,824 bytes, over 96 MiB.
    const nodes = [
      group('a', null, ['b']),
      group('b', 'a', ['c']),
      group('c', 'b', ['leaf']),
      fullScreen('leaf', 'c'),
    ];
    service.replaceSnapshot({
      identity: { documentId: 'e25-u4', pageId: 'page' },
      revision: 1,
      nodes,
      rootOrder: ['a'],
    });
    clock.flush();
    const limits = () =>
      diagnostics.filter((diagnostic) => diagnostic.code === DIAGNOSTIC_CODES.LAYER_RESOURCE_LIMIT);
    expect(limits()).toEqual([
      expect.objectContaining({
        severity: 'warning',
        generation: 1,
        context: { nodeId: 'a', bytes: 3 * 33_177_600 + 25_165_824, limit: 96 * 1024 * 1024 },
      }),
    ]);
    // The tree stays over budget: no new notice on later frames.
    backend.invalidate({ reason: 'interaction' });
    clock.flush();
    expect(limits()).toHaveLength(1);
    backend.dispose();
    service.dispose();
  });
});
