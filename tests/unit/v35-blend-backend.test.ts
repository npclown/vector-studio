import type { RenderNodeSnapshot, RenderSceneSnapshot } from '@vector-studio/contracts';
import { PrimitiveRendererService, type AnimationFrameClock } from '@vector-studio/renderer-core';
import {
  WebGpuBackend,
  createBrowserWebGpuPlatform,
  type WebGpuBackendOptions,
  type WebGpuPlatform,
} from '@vector-studio/renderer-webgpu';
import { afterEach, describe, expect, it } from 'vitest';
import { GpuRecorder, installRecordedBrowserGpu } from '../support/e10-gpu-recorder.js';
import { createCountingPort, identity, rectangleNode } from '../support/v3a-path-harness.js';
import { ScriptedStrokeMeshPort } from '../support/st-u6-stroke-harness.js';

// V-35 contract (docs/plans/viz-v35-fills-blend-contract.md), U4: the backend half of V35-K4 and
// K7 on a recorded fake device through the browser platform: the canvas configuration's usage
// under `blend: 'v0'` and `'none'` (the E10 section 3.2 amendment), and the fallback at 1x when
// the platform drops TEXTURE_BINDING from the canvas (blend roots draw as `normal`).

class ManualClock implements AnimationFrameClock {
  #callbacks = new Map<number, (timestampMs: number) => void>();
  #next = 0;
  #now = 0;

  public request(callback: (timestampMs: number) => void): number {
    this.#next += 1;
    this.#callbacks.set(this.#next, callback);
    return this.#next;
  }

  public cancel(handle: number): void {
    this.#callbacks.delete(handle);
  }

  public tick(): void {
    const callbacks = [...this.#callbacks.values()];
    this.#callbacks.clear();
    this.#now += 16;
    for (const callback of callbacks) callback(this.#now);
  }
}

function scene(): RenderSceneSnapshot {
  const nodes: RenderNodeSnapshot[] = [
    rectangleNode('backdrop', 0),
    { ...rectangleNode('blended', 4), blendMode: 'multiply' },
  ];
  return { identity, revision: 1, nodes, rootOrder: nodes.map((node) => node.id) };
}

let restore: (() => void) | undefined;
afterEach(() => {
  restore?.();
  restore = undefined;
});

type Setup = Readonly<{
  blend: 'none' | 'v0';
  options?: WebGpuBackendOptions;
  platform?: (browser: WebGpuPlatform) => WebGpuPlatform;
}>;

async function setup(input: Setup) {
  const recorder = new GpuRecorder();
  const installed = installRecordedBrowserGpu(recorder, 'bgra8unorm');
  restore = () => installed.restore();
  const clock = new ManualClock();
  const browser = createBrowserWebGpuPlatform();
  const backend = new WebGpuBackend({
    animationFrameClock: clock,
    now: () => 0,
    platform: input.platform?.(browser) ?? browser,
    ...input.options,
  });
  const service = new PrimitiveRendererService(backend, {
    fillMesh: createCountingPort(),
    strokeMesh: new ScriptedStrokeMeshPort(),
    clips: 'rect',
    groups: 'isolated',
    ...(input.blend === 'v0' ? { blend: 'v0' as const } : {}),
  });
  backend.attachPrimitiveFrameSource(service);
  const result = await backend.initialize({
    canvas: installed.canvas,
    cssSize: { width: 64, height: 32 },
    devicePixelRatio: 1,
  });
  expect(result.supported).toBe(true);
  return { recorder, clock, backend, service };
}

const configuredUsage = (recorder: GpuRecorder) =>
  (
    recorder.log.find(([name]) => String(name).endsWith('.configure'))?.[1] as
      { usage?: number } | undefined
  )?.usage;

/** A platform whose canvas configure drops `usage`, as a host that does not know it. */
const droppingUsage = (browser: WebGpuPlatform): WebGpuPlatform => ({
  secureContext: browser.secureContext,
  apiAvailable: browser.apiAvailable,
  requestAdapter: () => browser.requestAdapter(),
  getPreferredCanvasFormat: () => browser.getPreferredCanvasFormat(),
  getCanvasContext: (canvas) => {
    const context = browser.getCanvasContext(canvas) as unknown as {
      native: GPUCanvasContext;
      configuredUsage: number | undefined;
      configure: (configuration: object) => void;
      unconfigure: () => void;
    };
    return {
      native: context.native,
      get configuredUsage() {
        return context.configuredUsage;
      },
      configure: (configuration: object) => {
        const rest: Record<string, unknown> = { ...configuration };
        delete rest.usage;
        context.configure(rest);
      },
      unconfigure: () => context.unconfigure(),
    } as never;
  },
});

describe('V-35 U4 canvas usage (V35-K4, the E10 section 3.2 amendment)', () => {
  it("blend 'none' configures the canvas as before: no usage key", async () => {
    const h = await setup({ blend: 'none' });
    expect(configuredUsage(h.recorder)).toBeUndefined();
    expect(h.backend.blendPipelineAvailable).toBe(false);
  });

  it("blend 'none' with frame capture keeps E10's COPY_SRC usage only", async () => {
    const h = await setup({ blend: 'none', options: { frameCaptureForTesting: true } });
    expect(configuredUsage(h.recorder)).toBe(0x11);
  });

  it("blend 'v0' adds TEXTURE_BINDING, and COPY_SRC with frame capture", async () => {
    const h = await setup({ blend: 'v0' });
    expect(configuredUsage(h.recorder)).toBe(0x14);
    restore?.();
    const captured = await setup({ blend: 'v0', options: { frameCaptureForTesting: true } });
    expect(configuredUsage(captured.recorder)).toBe(0x15);
  });

  it("blend 'v0' at 1x draws the blend root with one split when the canvas is readable", async () => {
    const h = await setup({ blend: 'v0', options: { sampleCountForTesting: 1 } });
    expect(h.backend.blendPipelineAvailable).toBe(true);
    h.service.replaceSnapshot(scene());
    h.service.setCamera({ position: { x: 0, y: 0 }, zoom: 1 });
    h.clock.tick();
    expect(h.backend.getStatistics().framesSubmitted).toBe(1);
    expect(h.backend.getBlendSplitsForTesting()).toBe(1);
  });
});

describe('V-35 U4 K7 fallback when the canvas refuses TEXTURE_BINDING', () => {
  it('at 1x: blending unavailable, the root draws as normal, with no split', async () => {
    const h = await setup({
      blend: 'v0',
      options: { sampleCountForTesting: 1 },
      platform: droppingUsage,
    });
    expect(h.backend.blendPipelineAvailable).toBe(false);
    h.service.replaceSnapshot(scene());
    h.service.setCamera({ position: { x: 0, y: 0 }, zoom: 1 });
    h.clock.tick();
    expect(h.backend.getStatistics().framesSubmitted).toBe(1);
    expect(h.backend.getBlendSplitsForTesting()).toBe(0);
  });

  it('at 4x the canvas is not read, so blending stays available', async () => {
    const h = await setup({ blend: 'v0', platform: droppingUsage });
    expect(h.backend.blendPipelineAvailable).toBe(true);
    h.service.replaceSnapshot(scene());
    h.service.setCamera({ position: { x: 0, y: 0 }, zoom: 1 });
    h.clock.tick();
    expect(h.backend.getBlendSplitsForTesting()).toBe(1);
  });
});
