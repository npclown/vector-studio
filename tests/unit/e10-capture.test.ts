import type {
  RendererCapabilityResult,
  RendererDiagnostic,
  RenderSceneSnapshot,
} from '@vector-studio/contracts';
import { PrimitiveRendererService, type AnimationFrameClock } from '@vector-studio/renderer-core';
import {
  WebGpuBackend,
  createBrowserWebGpuPlatform,
  type WebGpuBackendOptions,
  type WebGpuPlatform,
} from '@vector-studio/renderer-webgpu';
import { afterEach, describe, expect, it } from 'vitest';
import { MESH_COUNT_SHADER } from '../../packages/renderer-webgpu/src/mesh-count-shader.js';
import { MESH_FILL_SHADER } from '../../packages/renderer-webgpu/src/mesh-fill-shader.js';
import {
  GpuRecorder,
  RECORDER_LIMITS,
  installRecordedBrowserGpu,
  type GpuIntercept,
} from '../support/e10-gpu-recorder.js';
import {
  createCountingPort,
  identity,
  pathNode,
  rectangleNode,
} from '../support/v3a-path-harness.js';
import { ScriptedStrokeMeshPort, strokedNode } from '../support/st-u6-stroke-harness.js';
import { createHash } from 'node:crypto';

// E10 contract, unit E10-U2 (docs/plans/d9-e10-renderer-test-hooks-contract.md, sections 3.2,
// 4 and 5): forced sample count, frame capture and count pass on a recorded fake device through
// the browser platform. Criteria E10-A3, E10-A4 and E10-A5. Functional evidence only: precision
// is UNVERIFIED against the 0.25 physical-pixel target; the headed checks are E10-A7.

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
  const nodes = [
    pathNode('fill', 0),
    strokedNode('joint', 40, { opacity: 0.5 }),
    rectangleNode('rect', 80),
  ];
  return { identity, revision: 1, nodes, rootOrder: nodes.map((node) => node.id) };
}

let restore: (() => void) | undefined;
afterEach(() => {
  restore?.();
  restore = undefined;
});

type Setup = Readonly<{
  options?: WebGpuBackendOptions;
  intercept?: GpuIntercept;
  limits?: Readonly<Record<string, number>>;
  port?: boolean;
  platform?: (browser: WebGpuPlatform) => WebGpuPlatform;
  size?: Readonly<{ width: number; height: number }>;
}>;

async function setup(input: Setup = {}) {
  const recorder = new GpuRecorder();
  recorder.intercept = input.intercept;
  const installed = installRecordedBrowserGpu(recorder, 'bgra8unorm', {
    ...(input.limits === undefined ? {} : { limits: input.limits }),
  });
  restore = () => installed.restore();
  const clock = new ManualClock();
  const browser = createBrowserWebGpuPlatform();
  const backend = new WebGpuBackend({
    animationFrameClock: clock,
    now: () => 0,
    platform: input.platform?.(browser) ?? browser,
    ...input.options,
  });
  const diagnostics: RendererDiagnostic[] = [];
  backend.subscribeDiagnostics((event) => diagnostics.push(event));
  const service = new PrimitiveRendererService(
    backend,
    input.port === false
      ? {}
      : { fillMesh: createCountingPort(), strokeMesh: new ScriptedStrokeMeshPort() },
  );
  backend.attachPrimitiveFrameSource(service);
  const result: RendererCapabilityResult = await backend.initialize({
    canvas: installed.canvas,
    cssSize: input.size ?? { width: 64, height: 32 },
    devicePixelRatio: 1,
  });
  if (result.supported) {
    service.replaceSnapshot(scene());
    service.setCamera({ position: { x: -10, y: -5 }, zoom: 1 });
  }
  return { recorder, installed, clock, backend, service, diagnostics, result };
}

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const names = (recorder: GpuRecorder) => recorder.log.map(([name]) => String(name));
const pipelineLabels = (recorder: Pick<GpuRecorder, 'log'>) =>
  recorder.log
    .filter(([name]) => String(name).endsWith('.createRenderPipelineAsync'))
    .map(([, descriptor]) => (descriptor as { label: string }).label);
const failureContext = (diagnostics: readonly RendererDiagnostic[]) =>
  diagnostics.find((event) => event.code === 'initialization.foundation-scene-failed')?.context;
const fourTexture = (log: readonly (readonly unknown[])[]) =>
  log.some(
    ([name, descriptor]) =>
      String(name).endsWith('.createTexture') &&
      (descriptor as { sampleCount?: number }).sampleCount === 4,
  );
const codeOf = (promise: Promise<unknown>) =>
  promise.then(
    () => 'resolved',
    (error: Error) => error.message.split(':')[0],
  );

describe('E10-A3 forced sample count', () => {
  it('E10-A3: 1 creates no 4x pipeline or attachment and emits no msaa-fallback', async () => {
    const h = await setup({ options: { sampleCountForTesting: 1 } });
    expect(h.result.supported && h.result.capabilities.sampleCount).toBe(1);
    expect(pipelineLabels(h.recorder).every((label) => label.endsWith('-1x'))).toBe(true);
    expect(h.diagnostics.some((event) => event.code === 'capability.msaa-fallback')).toBe(false);
    h.clock.tick();
    expect(fourTexture(h.recorder.log)).toBe(false);
  });

  it('E10-A3: 4 with 4x rejected fails initialization with forcedSampleCount and creates no 1x pipeline', async () => {
    for (const reject of ['-4x', 'p3-mesh-fill-4x']) {
      const h = await setup({
        options: { sampleCountForTesting: 4 },
        intercept: ({ method, args }) =>
          method === 'createRenderPipelineAsync' &&
          String((args[0] as { label?: string }).label).includes(reject)
            ? { value: Promise.reject(new Error('4x unavailable')) }
            : undefined,
      });
      expect(h.result.supported).toBe(false);
      expect(failureContext(h.diagnostics)).toEqual({ forcedSampleCount: 4 });
      expect(pipelineLabels(h.recorder).some((label) => label.endsWith('-1x'))).toBe(false);
      restore?.();
      restore = undefined;
    }
  });

  it('E10-A3: 4 with 4x available reports sampleCount 4, also after a device-loss recovery', async () => {
    const h = await setup({ options: { sampleCountForTesting: 4 } });
    expect(h.result.supported && h.result.capabilities.sampleCount).toBe(4);
    const start = h.recorder.log.length;
    h.installed.loseDevice('unknown');
    await flush();
    await flush();
    expect(h.backend.generation).toBe(2);
    expect(h.backend.state).toBe('ready');
    const recovered = pipelineLabels({ log: h.recorder.log.slice(start) });
    expect(recovered.length).toBeGreaterThan(0);
    expect(recovered.every((label) => label.endsWith('-4x'))).toBe(true);
    expect(h.diagnostics.some((event) => event.code === 'capability.msaa-fallback')).toBe(false);
  });

  it('E10-A3: 4 rejected only after a device loss fails the recovery with forcedSampleCount and creates no 1x pipeline', async () => {
    let lost = false;
    const h = await setup({
      options: { sampleCountForTesting: 4 },
      intercept: ({ method, args }) =>
        lost &&
        method === 'createRenderPipelineAsync' &&
        String((args[0] as { label?: string }).label).endsWith('-4x')
          ? { value: Promise.reject(new Error('4x unavailable')) }
          : undefined,
    });
    expect(h.result.supported).toBe(true);
    lost = true;
    h.installed.loseDevice('unknown');
    await flush();
    await flush();
    expect(h.backend.state).not.toBe('ready');
    expect(h.diagnostics.map((event) => event.context)).toContainEqual({ forcedSampleCount: 4 });
    expect(pipelineLabels(h.recorder).some((label) => label.endsWith('-1x'))).toBe(false);
  });

  it('E10-A3: 1 stays 1x after a device-loss recovery, with no msaa-fallback and no 4x texture', async () => {
    const h = await setup({ options: { sampleCountForTesting: 1 } });
    h.installed.loseDevice('unknown');
    await flush();
    await flush();
    expect(h.backend.generation).toBe(2);
    expect(h.backend.state).toBe('ready');
    h.clock.tick();
    expect(pipelineLabels(h.recorder).every((label) => label.endsWith('-1x'))).toBe(true);
    expect(h.diagnostics.some((event) => event.code === 'capability.msaa-fallback')).toBe(false);
    expect(fourTexture(h.recorder.log)).toBe(false);
  });

  it('E10-A3: under a hook, a missing mesh or count pipeline fails initialization; without a port it initializes', async () => {
    const low = await setup({
      options: { sampleCountForTesting: 1 },
      limits: { ...RECORDER_LIMITS, maxStorageBuffersPerShaderStage: 4 },
    });
    expect(low.result.supported).toBe(false);
    expect(failureContext(low.diagnostics)).toEqual({ meshPipeline: 'unavailable' });
    restore?.();
    const count = await setup({
      options: { frameCaptureForTesting: true, countPassForTesting: true },
      intercept: ({ method, args }) =>
        method === 'createRenderPipelineAsync' &&
        String((args[0] as { label?: string }).label).includes('e10-count')
          ? { value: Promise.reject(new Error('count unavailable')) }
          : undefined,
    });
    expect(count.result.supported).toBe(false);
    expect(failureContext(count.diagnostics)).toEqual({ countPipeline: 'unavailable' });
    restore?.();
    // A failed mesh pipeline under the count pass reports the mesh pipeline, not the count.
    const mesh = await setup({
      options: { frameCaptureForTesting: true, countPassForTesting: true },
      intercept: ({ method, args }) =>
        method === 'createRenderPipelineAsync' &&
        String((args[0] as { label?: string }).label).includes('p3-mesh-fill')
          ? { value: Promise.reject(new Error('mesh unavailable')) }
          : undefined,
    });
    expect(mesh.result.supported).toBe(false);
    expect(failureContext(mesh.diagnostics)).toEqual({ meshPipeline: 'unavailable' });
    restore?.();
    const noPort = await setup({ options: { sampleCountForTesting: 1 }, port: false });
    expect(noPort.result.supported).toBe(true);
  });

  it('E10-A3: an invalid forced sample count or a count pass without capture is a programming error', () => {
    expect(() => new WebGpuBackend({ sampleCountForTesting: 2 as 1 })).toThrow(RangeError);
    expect(() => new WebGpuBackend({ countPassForTesting: true })).toThrow(RangeError);
  });
});

describe('E10-A4 frame capture', () => {
  it('E10-A4: the copy is in the frame encoder after the main pass, from that frame texture, with one submit', async () => {
    const h = await setup({ options: { frameCaptureForTesting: true } });
    const configure = h.recorder.log.find(([name]) => String(name).endsWith('.configure'));
    expect((configure![1] as { usage?: number }).usage).toBe(0x11);
    // A first frame allocates the arenas, so the baseline is taken after it.
    h.clock.tick();
    h.service.setCamera({ position: { x: -9, y: -5 }, zoom: 1 });
    const before = h.backend.getStatistics().resources.live;
    const pending = h.backend.captureFrameForTesting();
    const start = h.recorder.log.length;
    h.clock.tick();
    const frame = names(h.recorder).slice(start);
    const texture = frame.findIndex((name) => name.endsWith('.getCurrentTexture'));
    const textureName = `getCurrentTexture#`;
    const copy = frame.findIndex((name) => name.endsWith('.copyTextureToBuffer'));
    const mainPass = frame.findIndex(
      (name, index) =>
        name.endsWith('.beginRenderPass') &&
        (h.recorder.log[start + index]![1] as { label?: string }).label ===
          'vector-studio/primitive-pass',
    );
    expect(mainPass).toBeGreaterThanOrEqual(0);
    const end = frame.findIndex((name, index) => index > mainPass && name.endsWith('.end'));
    const finish = frame.findIndex((name) => name.endsWith('.finish'));
    expect(texture).toBeGreaterThanOrEqual(0);
    expect(end).toBeLessThan(copy);
    expect(copy).toBeLessThan(finish);
    expect(frame.filter((name) => name.endsWith('.submit'))).toHaveLength(1);
    const copyEntry = h.recorder.log[start + copy]!;
    expect(String((copyEntry[1] as { texture: string }).texture)).toContain(textureName);
    const capture = await pending;
    expect(capture).toMatchObject({
      generation: 1,
      width: 64,
      height: 32,
      sampleCount: 4,
      targetFormat: 'bgra8unorm',
      devicePixelRatio: 1,
      framesSubmitted: h.backend.getStatistics().framesSubmitted,
    });
    expect(capture.rgba).toHaveLength(64 * 32 * 4);
    expect(capture.meshDraws.map((draw) => draw.composite)).toEqual([
      'plain',
      'joint-fill',
      'plain',
    ]);
    expect(capture.counts).toBeUndefined();
    expect(h.backend.getStatistics().resources.live).toBe(before);
  });

  it('E10-A4: bgra8unorm pixels are swizzled to RGBA and row padding removed', async () => {
    const h = await setup({
      options: { frameCaptureForTesting: true },
      intercept: ({ method, owner }) => {
        if (method !== 'getMappedRange' || !owner.startsWith('Buffer')) return undefined;
        // 64 px * 4 B = 256 B per row: no padding; each pixel B, G, R, A = 1, 2, 3, 4.
        const bytes = new Uint8Array(256 * 32);
        for (let index = 0; index < bytes.length; index += 4) bytes.set([1, 2, 3, 4], index);
        return { value: bytes.buffer };
      },
    });
    const pending = h.backend.captureFrameForTesting();
    h.clock.tick();
    const capture = await pending;
    expect(Array.from(capture.rgba.subarray(0, 8))).toEqual([3, 2, 1, 4, 3, 2, 1, 4]);
  });

  it('E10-A4: COPY_SRC is configured only with the option; a platform that drops it is refused', async () => {
    const plain = await setup();
    const configure = plain.recorder.log.find(([name]) => String(name).endsWith('.configure'));
    expect(configure![1]).not.toHaveProperty('usage');
    restore?.();
    const dropping = await setup({
      options: { frameCaptureForTesting: true },
      platform: (browser) => ({
        secureContext: browser.secureContext,
        apiAvailable: browser.apiAvailable,
        requestAdapter: () => browser.requestAdapter(),
        getPreferredCanvasFormat: () => browser.getPreferredCanvasFormat(),
        getCanvasContext: (canvas) => {
          const context = browser.getCanvasContext(canvas) as unknown as {
            native: GPUCanvasContext;
            configure: (configuration: object) => void;
            unconfigure: () => void;
          };
          // A host platform that does not know the usage field.
          return {
            native: context.native,
            configure: (configuration: object) => {
              const rest: Record<string, unknown> = { ...configuration };
              delete rest.usage;
              context.configure(rest);
            },
            unconfigure: () => context.unconfigure(),
          } as never;
        },
      }),
    });
    expect(dropping.result.supported).toBe(false);
    expect(
      dropping.diagnostics.find(
        (event) => event.code === 'initialization.surface-configuration-failed',
      )?.context,
    ).toEqual({ captureUsage: 'missing' });
  });

  it('E10-A4: each rejection code is reachable and none leaves a test resource', async () => {
    const code = (promise: Promise<unknown>) =>
      promise.then(
        () => 'resolved',
        (error: Error) => error.message.split(':')[0],
      );
    const disabled = await setup();
    expect(await code(disabled.backend.captureFrameForTesting())).toBe('capture-disabled');
    restore?.();

    const h = await setup({ options: { frameCaptureForTesting: true } });
    h.clock.tick();
    const live = () => h.backend.getStatistics().resources.live;
    const baseline = live();
    expect(await code(h.backend.captureFrameForTesting({ counts: true }))).toBe('capture-disabled');
    const first = code(h.backend.captureFrameForTesting());
    expect(await code(h.backend.captureFrameForTesting())).toBe('capture-pending');
    // A zero-size surface is suspended: the render returns before it submits.
    h.backend.resize({ width: 0, height: 0 }, 1);
    h.clock.tick();
    expect(await first).toBe('no-submission');
    h.backend.resize({ width: 64, height: 32 }, 1);
    expect(await code(h.backend.captureFrameForTesting({ timeoutMs: 5 }))).toBe('timeout');
    const lost = code(h.backend.captureFrameForTesting());
    h.installed.loseDevice('unknown');
    await flush();
    await flush();
    h.clock.tick();
    expect(await lost).toBe('device-lost');
    const disposed = code(h.backend.captureFrameForTesting());
    expect(live()).toBe(baseline);
    h.backend.dispose();
    expect(await disposed).toBe('disposed');
    expect(await code(h.backend.captureFrameForTesting())).toBe('disposed');
    restore?.();

    const fresh = new WebGpuBackend({ frameCaptureForTesting: true });
    expect(await code(fresh.captureFrameForTesting())).toBe('not-ready');
  });

  it('E10-A4: a capture between submit and readback settles on device loss and dispose, after its buffers are released', async () => {
    for (const end of ['loss', 'dispose'] as const) {
      const mapped = new Set<string>();
      const h = await setup({
        options: { frameCaptureForTesting: true },
        intercept: ({ owner, method }) => {
          if (method !== 'mapAsync') return undefined;
          mapped.add(owner);
          // The readback never completes on its own.
          return { value: new Promise<never>(() => undefined) };
        },
      });
      let atSettle: string[] = [];
      const pending = h.backend.captureFrameForTesting();
      const settled = codeOf(
        pending.finally(() => {
          atSettle = names(h.recorder);
        }),
      );
      h.clock.tick();
      expect(mapped.size).toBe(1);
      if (end === 'loss') {
        h.installed.loseDevice('unknown');
        await flush();
        await flush();
        expect(await settled).toBe('device-lost');
      } else {
        h.backend.dispose();
        expect(await settled).toBe('disposed');
      }
      for (const owner of mapped) expect(atSettle).toContain(`${owner}.destroy`);
      restore?.();
      restore = undefined;
    }
  });

  it('E10-A4: foundation mode and a scene port without capture reject', async () => {
    const recorder = new GpuRecorder();
    const installed = installRecordedBrowserGpu(recorder);
    restore = () => installed.restore();
    const backend = new WebGpuBackend({ frameCaptureForTesting: true, now: () => 0 });
    await backend.initialize({
      canvas: installed.canvas,
      cssSize: { width: 16, height: 16 },
      devicePixelRatio: 1,
    });
    await expect(backend.captureFrameForTesting()).rejects.toThrow(/^foundation-mode/);
    backend.dispose();
    restore();
    const h = await setup({
      options: { frameCaptureForTesting: true },
      platform: (browser) => ({
        secureContext: browser.secureContext,
        apiAvailable: browser.apiAvailable,
        getCanvasContext: (canvas) => browser.getCanvasContext(canvas),
        getPreferredCanvasFormat: () => browser.getPreferredCanvasFormat(),
        requestAdapter: async () => {
          const adapter = (await browser.requestAdapter())!;
          return {
            info: adapter.info,
            requestDevice: async () => {
              const device = await adapter.requestDevice();
              return new Proxy(device, {
                get(target, key) {
                  if (key !== 'createPrimitiveScene') {
                    const value = Reflect.get(target, key) as unknown;
                    return typeof value === 'function'
                      ? (value as (...args: unknown[]) => unknown).bind(target)
                      : value;
                  }
                  return (...args: Parameters<NonNullable<typeof device.createPrimitiveScene>>) => {
                    const creation = target.createPrimitiveScene!(...args);
                    return {
                      dispose: () => creation.dispose(),
                      result: creation.result.then(({ scene, fellBackFrom4x }) => ({
                        fellBackFrom4x,
                        scene: {
                          sampleCount: scene.sampleCount,
                          shaderModulesCreated: scene.shaderModulesCreated,
                          pipelinesCreated: scene.pipelinesCreated,
                          meshPipelineAvailable: scene.meshPipelineAvailable,
                          setTarget: (target: Parameters<typeof scene.setTarget>[0]) =>
                            scene.setTarget(target),
                          submitPrimitivePacket: (
                            packet: Parameters<typeof scene.submitPrimitivePacket>[0],
                          ) => scene.submitPrimitivePacket(packet),
                          dispose: () => scene.dispose(),
                        },
                      })),
                    };
                  };
                },
              });
            },
          };
        },
      }),
    });
    expect(h.result.supported).toBe(true);
    await expect(h.backend.captureFrameForTesting()).rejects.toThrow(/^capture-unsupported/);
  });
});

describe('E10-A5 count pass', () => {
  async function counted(sampleCount: 1 | 4, intercept?: GpuIntercept) {
    const h = await setup({
      options: {
        frameCaptureForTesting: true,
        countPassForTesting: true,
        sampleCountForTesting: sampleCount,
      },
      ...(intercept === undefined ? {} : { intercept }),
    });
    const start = h.recorder.log.length;
    const pending = h.backend.captureFrameForTesting({ counts: true });
    h.clock.tick();
    return { ...h, pending, frame: h.recorder.log.slice(start) };
  }

  it('E10-A5: the count module starts with MESH_FILL_SHADER verbatim and adds only a fragment entry point', async () => {
    expect(MESH_COUNT_SHADER.startsWith(MESH_FILL_SHADER)).toBe(true);
    const h = await counted(4);
    const sha = createHash('sha256').update(MESH_COUNT_SHADER).digest('hex');
    const modules = h.recorder.log
      .filter(([name]) => String(name).endsWith('.createShaderModule'))
      .map(([, descriptor]) => (descriptor as { code: string }).code);
    expect(modules).toContain(`sha256:${sha}`);
    // P1, mesh, E17 reset, count and readout modules; P1, mesh and E17 reset pipelines plus
    // three count pipelines and the E17 count reset pipeline.
    expect(h.result.supported && h.backend.getStatistics()).toMatchObject({
      shaderModulesCreated: 5,
      pipelinesCreated: 8,
    });
    const capture = await h.pending;
    expect(capture.counts!.samples).toBe(4);
    expect(capture.counts!.data).toHaveLength(64 * 32 * 4);
  });

  it('E10-A5: the count draws replay the main mesh draws with the same bind group; no analytic draw', async () => {
    for (const sampleCount of [1, 4] as const) {
      const h = await counted(sampleCount);
      await h.pending;
      const passes: Array<{ name: string; calls: (readonly unknown[])[] }> = [];
      for (const entry of h.frame) {
        const name = String(entry[0]);
        if (name.endsWith('.beginRenderPass')) {
          passes.push({ name: (entry[1] as { label?: string }).label ?? '', calls: [] });
        } else if (name.startsWith('beginRenderPass#')) {
          passes.at(-1)!.calls.push([name.slice(name.indexOf('.') + 1), ...entry.slice(1)]);
        }
      }
      const [main, count] = passes;
      expect(count!.name).toBe('vector-studio/e10-count-pass');
      const meshDraws = (calls: (readonly unknown[])[]) =>
        calls.filter(([method]) => method === 'draw');
      expect(meshDraws(count!.calls)).toEqual(meshDraws(main!.calls));
      expect(count!.calls.some(([method]) => method === 'drawIndexed')).toBe(false);
      const meshGroup = main!.calls.filter(([method]) => method === 'setBindGroup')[1]!;
      expect(count!.calls.find(([method]) => method === 'setBindGroup')).toEqual(meshGroup);
      const labels = pipelineLabels(h.recorder);
      expect(labels).toContain(`vector-studio/e10-count-joint-${sampleCount}x`);
      const jointPipeline = h.recorder.log.find(
        ([name, descriptor]) =>
          String(name).endsWith('.createRenderPipelineAsync') &&
          (descriptor as { label: string }).label ===
            `vector-studio/e10-count-joint-${sampleCount}x`,
      )![1] as { vertex: { entryPoint: string } };
      expect(jointPipeline.vertex.entryPoint).toBe('meshJointVertexMain');
      expect(passes).toHaveLength(sampleCount === 4 ? 3 : 2);
      restore?.();
      restore = undefined;
    }
  });

  it('E10-A5: counts and pixels are decoded per sample with row padding removed', async () => {
    for (const sampleCount of [1, 4] as const) {
      // Width 50: RGBA rows are 200 B padded to 256 B, count rows 400 B padded to 512 B.
      const width = 50;
      const height = 32;
      const mapped = new Set<string>();
      const h = await setup({
        size: { width, height },
        options: {
          frameCaptureForTesting: true,
          countPassForTesting: true,
          sampleCountForTesting: sampleCount,
        },
        intercept: ({ owner, method }) => {
          if (method === 'mapAsync') mapped.add(owner);
          if (method !== 'getMappedRange' || !mapped.has(owner)) return undefined;
          const size = h.recorder.sizeOf(owner);
          if (size === 256 * height) {
            // Each row's pixels are B, G, R, A = row, 2 * row, 3 * row, 255; padding is 0xee.
            const bytes = new Uint8Array(size).fill(0xee);
            for (let row = 0; row < height; row += 1) {
              for (let column = 0; column < width; column += 1) {
                bytes.set([row, 2 * row, 3 * row, 255], row * 256 + column * 4);
              }
            }
            return { value: bytes.buffer };
          }
          // Counts: 1 at pixel (3, 2) sample 0, 2 at pixel (49, 31) last sample; padding 0xee.
          const bytes = new Uint8Array(size ?? 0);
          for (let row = 0; row < height; row += 1)
            bytes.fill(0xee, row * 512 + width * 8, (row + 1) * 512);
          const view = new DataView(bytes.buffer);
          view.setUint16(2 * 512 + 3 * 8, 0x3c00, true);
          view.setUint16(31 * 512 + 49 * 8 + (sampleCount - 1) * 2, 0x4000, true);
          return { value: bytes.buffer };
        },
      });
      const pending = h.backend.captureFrameForTesting({ counts: true });
      h.clock.tick();
      const capture = await pending;
      expect(capture.width).toBe(width);
      expect(Array.from(capture.rgba.subarray((1 * width + 49) * 4, 2 * width * 4 + 4))).toEqual([
        3, 2, 1, 255, 6, 4, 2, 255,
      ]);
      expect(capture.rgba.includes(0xee)).toBe(false);
      const data = capture.counts!.data;
      expect(data).toHaveLength(width * height * sampleCount);
      expect(data[(2 * width + 3) * sampleCount]).toBe(1);
      expect(data[(31 * width + 49) * sampleCount + sampleCount - 1]).toBe(2);
      expect(data.reduce((sum, value) => sum + value, 0)).toBe(3);
      restore?.();
      restore = undefined;
    }
  });

  it('E10-A5: counts without count pipelines reject capture-disabled and the product frame still submits', async () => {
    // Without a fill port the source needs no mesh pipeline, so no count pipelines exist.
    const h = await setup({
      options: { frameCaptureForTesting: true, countPassForTesting: true },
      port: false,
    });
    // Rectangles only: without a fill port, path nodes would hold the frame back.
    h.service.replaceSnapshot({
      identity,
      revision: 2,
      nodes: [rectangleNode('rect', 80)],
      rootOrder: ['rect'],
    });
    h.clock.tick();
    expect(h.backend.getStatistics().framesSubmitted).toBeGreaterThan(0);
    const frames = h.backend.getStatistics().framesSubmitted;
    h.service.setCamera({ position: { x: -9, y: -5 }, zoom: 1 });
    const pending = codeOf(h.backend.captureFrameForTesting({ counts: true }));
    h.clock.tick();
    expect(await pending).toBe('capture-disabled');
    expect(h.backend.getStatistics().framesSubmitted).toBe(frames + 1);
    expect(h.diagnostics.some((event) => event.code.includes('submission'))).toBe(false);
  });

  it('E10-A5: a count of 2048 or more rejects with count-overflow and releases its buffers', async () => {
    let overflow = false;
    const h = await setup({
      options: {
        frameCaptureForTesting: true,
        countPassForTesting: true,
        sampleCountForTesting: 1,
      },
      intercept: ({ method, owner }) => {
        if (!overflow || method !== 'getMappedRange' || !owner.startsWith('Buffer'))
          return undefined;
        const bytes = new Uint8Array(512 * 32);
        new DataView(bytes.buffer).setUint16(0, 0x6800, true); // binary16 2048
        return { value: bytes.buffer };
      },
    });
    h.clock.tick();
    h.service.setCamera({ position: { x: -9, y: -5 }, zoom: 1 });
    const baseline = h.backend.getStatistics().resources.live;
    overflow = true;
    const pending = h.backend.captureFrameForTesting({ counts: true });
    h.clock.tick();
    await expect(pending).rejects.toThrow(/^count-overflow/);
    expect(h.backend.getStatistics().resources.live).toBe(baseline);
  });
});
