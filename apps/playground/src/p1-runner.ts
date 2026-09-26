import type { RendererDiagnostic, RendererCapabilityResult } from '@vector-studio/contracts';
import { PrimitiveRendererService, type PrimitiveResourceId } from '@vector-studio/renderer-core';
import {
  WebGpuBackend,
  createBrowserWebGpuPlatform,
  type WebGpuDevicePort,
  type WebGpuPlatform,
} from '@vector-studio/renderer-webgpu';
import { cameraAt, createP1Workload, nodeAt, type P1Scenario } from './p1-workloads.js';
import {
  summarizeP1Frames,
  type P1FrameObservation,
  type P1WriteObservation,
} from './p1-run-metrics.js';

type MutableFrame = { -readonly [K in keyof P1FrameObservation]: P1FrameObservation[K] } & {
  writes: P1WriteObservation[];
  errors: string[];
};
type Binding = { resource: PrimitiveResourceId; offset: number; size: number };
const resourceIds = ['transforms', 'geometry', 'styles', 'order', 'frame'] as const;
const profile = { name: 'functional', warmupFrames: 3, measuredFrames: 5 } as const;
let used = false;

function member(target: object, key: string | symbol): unknown {
  const value: unknown = Reflect.get(target, key);
  return typeof value === 'function' ? value.bind(target) : value;
}

async function run(scenario: P1Scenario) {
  if (used) throw new Error('Use a fresh page for every functional case.');
  used = true;
  const workload = createP1Workload(scenario);
  const frames: P1FrameObservation[] = [];
  const diagnostics: RendererDiagnostic[] = [];
  const errors: string[] = [];
  const visibility: { time: number; state: string }[] = [];
  const initialWrites: { label: string; offset: number; bytes: number }[] = [];
  const bindings = new WeakMap<GPUBuffer, Binding[]>();
  let current: MutableFrame | undefined;
  let active = false;
  let origin: number | undefined;
  let revision = 0;
  let observedDevice: WebGpuDevicePort | undefined;
  const pendingCallbacks = new Set<number>();
  let maximumPendingCallbacks = 0;
  let capability: RendererCapabilityResult | undefined;
  let complete: (() => void) | undefined;
  let timer: number | undefined;
  const done = new Promise<void>((resolve) => {
    complete = resolve;
  });
  const onVisibility = () =>
    visibility.push({ time: performance.now(), state: document.visibilityState });
  document.addEventListener('visibilitychange', onVisibility);
  const browser = createBrowserWebGpuPlatform();
  const devices = new WeakMap<WebGpuDevicePort, WebGpuDevicePort>();
  const platform: WebGpuPlatform = {
    secureContext: browser.secureContext,
    apiAvailable: browser.apiAvailable,
    getPreferredCanvasFormat: () => browser.getPreferredCanvasFormat(),
    getCanvasContext(canvas) {
      const context = browser.getCanvasContext(canvas);
      if (context === null) return null;
      return new Proxy(context, {
        get(target, key) {
          if (key === 'configure')
            return (configuration: Parameters<typeof context.configure>[0]) =>
              target.configure({
                ...configuration,
                device: devices.get(configuration.device) ?? configuration.device,
              });
          return member(target, key);
        },
      });
    },
    async requestAdapter() {
      const adapter = await browser.requestAdapter();
      if (adapter === null) return null;
      return {
        info: adapter.info,
        async requestDevice() {
          const port = await adapter.requestDevice();
          observedDevice = port;
          const native = (port as WebGpuDevicePort & { native: GPUDevice }).native;
          const queue = new Proxy(native.queue, {
            get(target, key) {
              if (key === 'writeBuffer')
                return (...args: Parameters<GPUQueue['writeBuffer']>) => {
                  target.writeBuffer(...args);
                  const [buffer, offset, data, dataOffset = 0, size] = args;
                  const elementSize =
                    ArrayBuffer.isView(data) && 'BYTES_PER_ELEMENT' in data
                      ? Number(data.BYTES_PER_ELEMENT)
                      : 1;
                  const bytes =
                    size === undefined
                      ? data.byteLength - dataOffset * elementSize
                      : size * elementSize;
                  if (current === undefined)
                    initialWrites.push({ label: buffer.label, offset, bytes });
                  else {
                    const binding = bindings
                      .get(buffer)
                      ?.find(
                        (range) =>
                          offset >= range.offset && offset + bytes <= range.offset + range.size,
                      );
                    current.writes.push({
                      resource: binding?.resource ?? 'unmapped',
                      offset: offset - (binding?.offset ?? 0),
                      bytes,
                      nativeBufferOffset: offset,
                    });
                  }
                };
              if (key === 'submit')
                return (...args: Parameters<GPUQueue['submit']>) => {
                  target.submit(...args);
                  if (current !== undefined) current.submissionCount += 1;
                };
              return member(target, key);
            },
          });
          const instrumented = new Proxy(native, {
            get(target, key) {
              if (key === 'queue') return queue;
              if (key === 'createShaderModule')
                return (descriptor: GPUShaderModuleDescriptor) => {
                  if (current !== undefined) current.shaderCreations += 1;
                  return target.createShaderModule(descriptor);
                };
              if (key === 'createRenderPipeline')
                return (descriptor: GPURenderPipelineDescriptor) => {
                  if (current !== undefined) current.pipelineCreations += 1;
                  return target.createRenderPipeline(descriptor);
                };
              if (key === 'createRenderPipelineAsync')
                return (descriptor: GPURenderPipelineDescriptor) => {
                  if (current !== undefined) current.pipelineCreations += 1;
                  return target.createRenderPipelineAsync(descriptor);
                };
              if (key === 'createBindGroup')
                return (descriptor: GPUBindGroupDescriptor) => {
                  const group = target.createBindGroup(descriptor);
                  for (const entry of descriptor.entries) {
                    const resource = resourceIds[entry.binding];
                    if (resource === undefined || !('buffer' in entry.resource)) continue;
                    const binding = entry.resource;
                    const ranges = bindings.get(binding.buffer) ?? [];
                    const offset = binding.offset ?? 0;
                    ranges.push({
                      resource,
                      offset,
                      size: binding.size ?? binding.buffer.size - offset,
                    });
                    bindings.set(binding.buffer, ranges);
                  }
                  return group;
                };
              if (key === 'createCommandEncoder')
                return (descriptor?: GPUCommandEncoderDescriptor) => {
                  const encoder = target.createCommandEncoder(descriptor);
                  return new Proxy(encoder, {
                    get(command, property) {
                      if (property === 'beginRenderPass')
                        return (passDescriptor: GPURenderPassDescriptor) => {
                          const pass = command.beginRenderPass({
                            ...passDescriptor,
                            colorAttachments: Array.from(
                              passDescriptor.colorAttachments,
                              (attachment) =>
                                attachment === null
                                  ? null
                                  : {
                                      ...attachment,
                                      clearValue: { r: 0.08, g: 0.1, b: 0.14, a: 1 },
                                    },
                            ),
                          });
                          return new Proxy(pass, {
                            get(renderPass, passKey) {
                              if (passKey === 'drawIndexed')
                                return (
                                  ...args: Parameters<GPURenderPassEncoder['drawIndexed']>
                                ) => {
                                  renderPass.drawIndexed(...args);
                                  if (current !== undefined)
                                    current.drawInstanceCount += args[1] ?? 1;
                                };
                              return member(renderPass, passKey);
                            },
                          });
                        };
                      return member(command, property);
                    },
                  });
                };
              return member(target, key);
            },
          });
          const wrapped: WebGpuDevicePort = new Proxy(port, {
            get(target, key) {
              if (key === 'native') return instrumented;
              if (key === 'createPrimitiveScene')
                return (
                  ...args: Parameters<NonNullable<WebGpuDevicePort['createPrimitiveScene']>>
                ) => target.createPrimitiveScene!.apply(wrapped, args);
              return member(target, key);
            },
          });
          devices.set(wrapped, port);
          return wrapped;
        },
      };
    },
  };

  const backend = new WebGpuBackend({
    platform,
    animationFrameClock: {
      request: (callback) => {
        const handle = requestAnimationFrame((timestampMs) => {
          pendingCallbacks.delete(handle);
          if (!active) {
            callback(timestampMs);
            return;
          }
          origin ??= timestampMs;
          current = {
            timestampMs,
            elapsedMs: timestampMs - origin,
            generation: backend.generation,
            sceneRevision: null,
            cameraRevision: null,
            submissionCount: 0,
            packetCount: 0,
            visibleCount: null,
            drawInstanceCount: 0,
            writes: [],
            pipelineCreations: 0,
            shaderCreations: 0,
            visible: document.visibilityState === 'visible',
            errors: [],
          };
          try {
            const camera = service.setCamera(cameraAt(scenario, current.elapsedMs));
            if (camera.status !== 'applied' && camera.status !== 'unchanged')
              throw new Error(JSON.stringify(camera));
            const node = nodeAt(workload, current.elapsedMs);
            if (node !== null) {
              const applied = service.applyChanges({
                identity: workload.snapshot.identity,
                baseRevision: revision,
                revision: revision + 1,
                inserted: [],
                removed: [],
                updated: [node],
                orders: [],
              });
              if (applied.status !== 'applied') throw new Error(JSON.stringify(applied));
              revision += 1;
            }
            if (frames.length === profile.warmupFrames + profile.measuredFrames - 1)
              backend.setMode('on-demand');
            callback(timestampMs);
          } catch (error) {
            current.errors.push(String(error));
            backend.setMode('on-demand');
            active = false;
          }
          frames.push(current);
          current = undefined;
          if (!active || frames.length === profile.warmupFrames + profile.measuredFrames) {
            active = false;
            complete!();
          }
        });
        pendingCallbacks.add(handle);
        maximumPendingCallbacks = Math.max(maximumPendingCallbacks, pendingCallbacks.size);
        return handle;
      },
      cancel: (handle) => {
        pendingCallbacks.delete(handle);
        cancelAnimationFrame(handle);
      },
    },
  });
  const service = new PrimitiveRendererService(backend);
  backend.attachPrimitiveFrameSource({
    prepare(target) {
      const packet = service.prepare(target);
      if (current !== undefined && packet !== null) {
        current.packetCount += 1;
        current.sceneRevision = packet.scene.revision;
        current.cameraRevision = packet.cameraRevision;
        current.visibleCount = packet.draws.reduce((sum, draw) => sum + draw.count, 0);
      }
      return packet;
    },
    acknowledge: (receipt) => service.acknowledge(receipt),
  });
  backend.subscribeDiagnostics((event) => {
    diagnostics.push(event);
    if (event.severity === 'error') current?.errors.push(event.code);
  });
  try {
    capability = await backend.initialize({
      canvas: document.querySelector<HTMLCanvasElement>('#surface')!,
      cssSize: { width: 1280, height: 720 },
      devicePixelRatio: 1,
    });
    if (!capability.supported || capability.capabilities.sampleCount !== 4)
      throw new Error('Functional reference workload requires native 4x support.');
    const applied = service.replaceSnapshot(workload.snapshot);
    if (applied.status !== 'applied') throw new Error(JSON.stringify(applied));
    active = true;
    backend.setMode('continuous');
    timer = window.setTimeout(() => {
      errors.push('Functional callback deadline exceeded.');
      complete!();
    }, 30_000);
    await done;
    await observedDevice?.waitForSubmittedWork();
    // Let native uncaptured-error events dispatch before removing device listeners.
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  } catch (error) {
    errors.push(String(error));
  } finally {
    active = false;
    if (timer !== undefined) clearTimeout(timer);
    service.dispose();
    backend.dispose();
    document.removeEventListener('visibilitychange', onVisibility);
  }
  const measurementWindow = {
    scenario,
    startMs: frames[profile.warmupFrames]?.elapsedMs ?? 0,
    endMs: (frames.at(-1)?.elapsedMs ?? 0) + 1,
  };
  return {
    profile,
    scenario,
    configuration: workload.configuration,
    frames,
    window: measurementWindow,
    metrics: summarizeP1Frames(frames, measurementWindow),
    capability,
    diagnostics,
    errors,
    visibility,
    initialWrites,
    maximumPendingCallbacks,
    pendingCallbacksAfterDispose: pendingCallbacks.size,
    disposed: backend.getStatistics(),
    environment: {
      timeOrigin: performance.timeOrigin,
      userAgent: navigator.userAgent,
      cssSize: {
        width: document.querySelector<HTMLCanvasElement>('#surface')!.getBoundingClientRect().width,
        height: document.querySelector<HTMLCanvasElement>('#surface')!.getBoundingClientRect()
          .height,
      },
      physicalSize: {
        width: document.querySelector<HTMLCanvasElement>('#surface')!.width,
        height: document.querySelector<HTMLCanvasElement>('#surface')!.height,
      },
      devicePixelRatio: 1,
      visibilityState: document.visibilityState,
    },
    unavailable: {
      cpuGeometryRebuilds: 'Upload absence does not observe CPU geometry rebuild events.',
      A09: 'No accepted complete simultaneous CPU/GPU peak method.',
      A10: 'No verified pointer/content/physical-presentation and clock linkage.',
    },
  };
}

Object.assign(globalThis, { __vectorStudioP1Runner: { run } });
export type P1FunctionalCapture = Awaited<ReturnType<typeof run>>;
