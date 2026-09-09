import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { expect, test, type Browser, type CDPSession, type Page } from '@playwright/test';

import {
  P0_BENCHMARK_SCHEMA,
  P0_RUNNER_ID,
  configurationHash,
  validateP0BenchmarkRecord,
  writeP0BenchmarkArtifacts,
  type BenchmarkMetric,
  type JsonValue,
  type P0BenchmarkRecord,
  type P0BenchmarkRepetition,
} from '../support/p0-benchmark-record.js';
import type { PlaygroundSnapshot } from '../support/playground-api.js';
import '../support/playground-api.js';

const profile = process.env.P0_BENCHMARK_PROFILE === 'smoke' ? 'smoke' : 'acceptance';
const outputDirectoryArgument = process.env.P0_BENCHMARK_OUTPUT_DIR ?? 'docs/benchmarks/results';
const outputDirectory = path.resolve(outputDirectoryArgument);
const settings =
  profile === 'acceptance'
    ? {
        repetitions: 5,
        steadyWarmupMs: 3000,
        steadyMeasuredMs: 10_000,
        idleObservedMs: 5000,
        resizeSteps: 120,
        lifecycleCycles: 25,
      }
    : {
        repetitions: 1,
        steadyWarmupMs: 100,
        steadyMeasuredMs: 500,
        idleObservedMs: 200,
        resizeSteps: 12,
        lifecycleCycles: 2,
      };
const launchFlags = ['--enable-unsafe-webgpu'];
const MEASUREMENT_CAPACITY = 4096;
const REFERENCE_SURFACE_CONFIGURATION = Object.freeze({
  cssSize: Object.freeze([1280, 720] as const),
  physicalSize: Object.freeze([1280, 720] as const),
  devicePixelRatio: 1,
});
const FOUNDATION_WORKLOAD = Object.freeze({
  sceneId: 'native-foundation-triangle-v1',
  objectCounts: Object.freeze({ renderedObjects: 1, triangles: 1, vertices: 3 }),
  drawCallsPerSubmittedFrame: 1,
  renderPassesPerSubmittedFrame: 1,
});
const RESIZE_SEQUENCE = Object.freeze({
  width: Object.freeze({ base: 900, stepMultiplier: 37, modulus: 380 }),
  height: Object.freeze({ base: 500, stepMultiplier: 23, modulus: 220 }),
  devicePixelRatios: Object.freeze([1, 1.5, 2] as const),
  pacing: 'one deterministic resize before each requestAnimationFrame',
});

function fixed(value: number): number {
  return Number(value.toFixed(3));
}

function percentile(values: readonly number[], fraction: number): number {
  if (values.length === 0) throw new TypeError('Cannot summarize an empty sample stream.');
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)] as number;
}

function available(
  value: number,
  unit: string,
  startEvent: string,
  endEvent: string,
  observation: string,
  clock = 'performance.now',
): BenchmarkMetric {
  return {
    availability: 'available',
    value: fixed(value),
    unit,
    clock,
    startEvent,
    endEvent,
    observation,
  };
}

function unavailable(
  reason: string,
  unit: string,
  startEvent: string,
  endEvent: string,
): BenchmarkMetric {
  return {
    availability: 'unavailable',
    reason,
    unit,
    clock: 'unavailable',
    startEvent,
    endEvent,
    observation: 'unavailable',
  };
}

function json(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

function sourceProvenance(): Pick<
  P0BenchmarkRecord['identity'],
  'revision' | 'sourceState' | 'sourceDelta'
> {
  const revision = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const status = execFileSync('git', ['status', '--short'], { encoding: 'utf8' })
    .split(/\r?\n/u)
    .filter(
      (entry) =>
        entry !== '' &&
        !entry.slice(3).startsWith('docs/benchmarks/results/') &&
        !entry.slice(3).startsWith('test-results/'),
    );
  if (status.length === 0) return { revision, sourceState: 'clean' };

  const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], {
    encoding: 'utf8',
  })
    .trim()
    .split(/\r?\n/u)
    .filter(
      (file) =>
        file !== '' &&
        !file.startsWith('docs/benchmarks/results/') &&
        !file.startsWith('test-results/'),
    )
    .sort();
  const manifest = createHash('sha256');
  for (const file of files) {
    manifest.update(file, 'utf8');
    manifest.update('\0', 'utf8');
    manifest.update(existsSync(file) ? readFileSync(file) : '<deleted>', 'utf8');
    manifest.update('\0', 'utf8');
  }
  return {
    revision,
    sourceState: 'dirty',
    sourceDelta: `sha256-source-manifest:${manifest.digest('hex')}`,
  };
}

async function prepare(page: Page, url = '/'): Promise<PlaygroundSnapshot> {
  await page.goto(url);
  await page.waitForFunction(() => window.__vectorStudioP0 !== undefined);
  await page.evaluate(() => window.__vectorStudioP0.waitForInitializationMilestones());
  await page.evaluate(() => window.__vectorStudioP0.resize(1280, 720, 1));
  await page.waitForFunction(
    () => window.__vectorStudioP0.snapshot().statistics.pendingFrameCallbacks === 0,
  );
  const snapshot = await page.evaluate(() => window.__vectorStudioP0.snapshot());
  expect(snapshot.capability.supported).toBe(true);
  expect(await page.evaluate(() => document.visibilityState)).toBe('visible');
  return snapshot;
}

async function environment(
  browser: Browser,
  page: Page,
  projectName: string,
  snapshot: PlaygroundSnapshot,
): Promise<P0BenchmarkRecord['environment']> {
  let actualWindowBounds: JsonValue = {
    availability: 'unavailable',
    reason: 'cdp-browser-window-bounds-query-failed',
  };
  let cdpSession: CDPSession | undefined;
  try {
    cdpSession = await page.context().newCDPSession(page);
    const windowResult = (await cdpSession.send('Browser.getWindowForTarget')) as unknown as {
      bounds: {
        left?: number;
        top?: number;
        width?: number;
        height?: number;
        windowState?: string;
      };
    };
    const { left, top, width, height, windowState } = windowResult.bounds;
    actualWindowBounds =
      [left, top, width, height].every((value) => Number.isFinite(value)) &&
      typeof windowState === 'string'
        ? json({
            availability: 'available',
            left,
            top,
            width,
            height,
            windowState,
            observation: 'CDP Browser.getWindowForTarget read-only query',
          })
        : {
            availability: 'unavailable',
            reason: 'cdp-browser-window-bounds-incomplete',
          };
  } catch {
    // Unavailability is retained in the environment record.
  } finally {
    await cdpSession?.detach().catch(() => undefined);
  }
  const browserEnvironment = await page.evaluate(async () => {
    const navigatorWithBattery = navigator as Navigator & {
      deviceMemory?: number;
      getBattery?: () => Promise<{ charging: boolean; level: number }>;
    };
    const battery = await navigatorWithBattery.getBattery?.();
    const performanceWithMemory = performance as Performance & {
      memory?: { usedJSHeapSize?: number };
    };
    const usedJSHeapSize = performanceWithMemory.memory?.usedJSHeapSize;
    return {
      hardwareConcurrency: navigator.hardwareConcurrency,
      deviceMemoryGiB: navigatorWithBattery.deviceMemory ?? null,
      powerSource:
        battery === undefined ? 'unavailable' : battery.charging ? 'AC/charging' : 'battery',
      batteryLevel: battery?.level ?? null,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      usedJSHeapSize:
        usedJSHeapSize !== undefined && Number.isFinite(usedJSHeapSize) ? usedJSHeapSize : null,
      visibilityState: document.visibilityState,
      windowPlacement: {
        screenX: window.screenX,
        screenY: window.screenY,
        outerWidth: window.outerWidth,
        outerHeight: window.outerHeight,
        screenWidth: window.screen.width,
        screenHeight: window.screen.height,
        screenAvailWidth: window.screen.availWidth,
        screenAvailHeight: window.screen.availHeight,
      },
    };
  });
  const refreshRate = Number(process.env.P0_DISPLAY_REFRESH_HZ);
  const preflightObservation = 'operator/shell preflight via CLI';
  const gpuDriver = process.env.P0_GPU_DRIVER;
  const powerSource = process.env.P0_POWER_SOURCE;
  const powerMode = process.env.P0_POWER_MODE;
  const backgroundLoad = process.env.P0_BACKGROUND_LOAD;
  const capabilities = snapshot.capability.capabilities;
  const surfaceSize = snapshot.surfaceSize;
  return {
    operatingSystem: `${os.platform()} ${os.release()} ${os.arch()}`,
    cpu: os.cpus()[0]?.model ?? 'unavailable',
    logicalCores: os.cpus().length,
    installedMemoryBytes: os.totalmem(),
    gpu: {
      ...(snapshot.capability.capabilities?.adapter ?? {}),
      driver:
        gpuDriver === undefined
          ? { availability: 'unavailable', reason: 'browser-webgpu-driver-not-exposed' }
          : { availability: 'available', value: gpuDriver, observation: preflightObservation },
    },
    webGpuLimits: snapshot.capability.capabilities?.limits ?? {},
    browser: { product: projectName, channel: projectName, version: browser.version() },
    browserLaunchFlags: launchFlags,
    displayRefreshRate:
      Number.isFinite(refreshRate) && refreshRate > 0
        ? {
            availability: 'available',
            value: refreshRate,
            unit: 'Hz',
            observation: preflightObservation,
          }
        : { availability: 'unavailable', reason: 'P0_DISPLAY_REFRESH_HZ-not-provided' },
    selectedFeatures:
      capabilities === undefined
        ? { availability: 'unavailable', reason: 'webgpu-capabilities-unavailable' }
        : capabilities.selectedFeatures,
    sampleCount:
      capabilities === undefined
        ? { availability: 'unavailable', reason: 'webgpu-capabilities-unavailable' }
        : capabilities.sampleCount,
    presentationFormat:
      snapshot.presentationFormat === undefined
        ? { availability: 'unavailable', reason: 'presentation-format-unavailable' }
        : snapshot.presentationFormat,
    viewport: {
      css: REFERENCE_SURFACE_CONFIGURATION.cssSize,
      physical:
        surfaceSize === undefined
          ? { availability: 'unavailable', reason: 'surface-size-unavailable' }
          : [surfaceSize.physical.width, surfaceSize.physical.height],
      devicePixelRatio:
        surfaceSize === undefined
          ? { availability: 'unavailable', reason: 'surface-size-unavailable' }
          : surfaceSize.devicePixelRatio,
      observation: 'requested CSS size and backend surface snapshot',
    },
    power: {
      source:
        powerSource === undefined
          ? { availability: 'unavailable', reason: 'P0_POWER_SOURCE-not-provided' }
          : { availability: 'available', value: powerSource, observation: preflightObservation },
      mode:
        powerMode === undefined
          ? { availability: 'unavailable', reason: 'P0_POWER_MODE-not-provided' }
          : { availability: 'available', value: powerMode, observation: preflightObservation },
      browserBattery: {
        source: browserEnvironment.powerSource,
        batteryLevel: browserEnvironment.batteryLevel,
        observation: 'navigator.getBattery',
      },
    },
    knownBackgroundLoad:
      backgroundLoad === undefined
        ? { availability: 'unavailable', reason: 'P0_BACKGROUND_LOAD-not-provided' }
        : {
            availability: 'available',
            value: backgroundLoad,
            observation: preflightObservation,
          },
    hostReportedLogicalCores: browserEnvironment.hardwareConcurrency,
    hostReportedMemoryGiB: browserEnvironment.deviceMemoryGiB,
    devTools: false,
    tracing: false,
    screenRecording: false,
    timezone: browserEnvironment.timezone,
    pageVisibility: {
      state: browserEnvironment.visibilityState,
      observation: 'document.visibilityState',
    },
    windowPlacement: {
      ...browserEnvironment.windowPlacement,
      observation: 'Playwright-emulated browser window and Screen API snapshot',
      context: 'emulated values; does not establish physical monitor association',
    },
    actualWindowBounds,
    browserHeap:
      browserEnvironment.usedJSHeapSize === null
        ? { availability: 'unavailable', reason: 'performance-memory-unavailable' }
        : {
            availability: 'available',
            usedBytes: browserEnvironment.usedJSHeapSize,
            observation: 'performance.memory.usedJSHeapSize initial-page snapshot',
          },
    processGpuMemory: {
      availability: 'unavailable',
      reason: 'browser-no-process-gpu-memory-api',
    },
  };
}

function record(
  scenarioId: string,
  scenarioVersion: number,
  configuration: JsonValue,
  repetitions: readonly P0BenchmarkRepetition[],
  environmentValue: P0BenchmarkRecord['environment'],
  provenance: ReturnType<typeof sourceProvenance>,
): P0BenchmarkRecord {
  const timezone = environmentValue.timezone;
  const fullConfiguration = json({
    scenarioVersion,
    seed: 0,
    profile,
    renderConfiguration: {
      selectedFeatures: environmentValue.selectedFeatures,
      selectedSampleCount: environmentValue.sampleCount,
      presentationFormat: environmentValue.presentationFormat,
    },
    parameters: configuration,
  });
  const command = [
    'pnpm benchmark:p0 --',
    `--profile ${profile}`,
    `--output-dir ${JSON.stringify(outputDirectoryArgument)}`,
    ...(process.env.P0_DISPLAY_REFRESH_HZ === undefined
      ? []
      : [`--display-refresh-hz ${process.env.P0_DISPLAY_REFRESH_HZ}`]),
    ...(process.env.P0_POWER_SOURCE === undefined
      ? []
      : [`--power-source ${JSON.stringify(process.env.P0_POWER_SOURCE)}`]),
    ...(process.env.P0_POWER_MODE === undefined
      ? []
      : [`--power-mode ${JSON.stringify(process.env.P0_POWER_MODE)}`]),
    ...(process.env.P0_BACKGROUND_LOAD === undefined
      ? []
      : [`--background-load ${JSON.stringify(process.env.P0_BACKGROUND_LOAD)}`]),
    ...(process.env.P0_GPU_DRIVER === undefined
      ? []
      : [`--gpu-driver ${JSON.stringify(process.env.P0_GPU_DRIVER)}`]),
  ].join(' ');
  return {
    schema: P0_BENCHMARK_SCHEMA,
    status: 'Exploratory',
    identity: {
      ...provenance,
      runId: randomUUID(),
      timestampUtc: new Date().toISOString(),
      localTimezone: typeof timezone === 'string' ? timezone : 'unavailable',
    },
    runner: {
      id: P0_RUNNER_ID,
      command,
      buildMode: 'production',
    },
    environment: environmentValue,
    scenario: {
      id: scenarioId,
      version: scenarioVersion,
      seed: 0,
      profile,
      configuration: fullConfiguration,
      configurationHash: configurationHash(fullConfiguration),
    },
    repetitions,
  };
}

function diagnostics(snapshot: PlaygroundSnapshot, expectedCodes: readonly string[] = []) {
  const expected = snapshot.diagnostics.filter(({ code }) => expectedCodes.includes(code ?? ''));
  const unexpected = snapshot.diagnostics.filter(
    ({ code, severity }) => severity === 'error' && !expectedCodes.includes(code ?? ''),
  );
  return {
    expected: json(expected) as readonly JsonValue[],
    unexpected: json(unexpected) as readonly JsonValue[],
  };
}

function metricSamples(name: string, values: readonly number[]) {
  return { sampleCounts: { [name]: values.length }, samples: { [name]: values } };
}

test('runs all P0 foundation scenarios and exports validated exploratory records', async ({
  browser,
  page,
}, testInfo) => {
  await page.addInitScript(() => {
    type RequestSpan = { durationMs: number; outcome: 'fulfilled' | 'rejected' };
    type RequestSpanState = {
      adapterRequests: RequestSpan[];
      deviceRequests: RequestSpan[];
      instrumentation: 'installed' | 'unavailable';
      unavailableReason?: string;
    };
    const requestSpans: RequestSpanState = {
      adapterRequests: [],
      deviceRequests: [],
      instrumentation: 'unavailable',
    };
    const recordRequestSpan = (target: RequestSpan[], span: RequestSpan): void => {
      try {
        target.push(span);
      } catch {
        requestSpans.instrumentation = 'unavailable';
        requestSpans.unavailableReason = 'webgpu-request-span-recording-failed';
      }
    };
    Object.defineProperty(window, '__p0GpuRequestSpans', { value: requestSpans });
    try {
      const gpu = navigator.gpu;
      if (gpu === undefined) throw new Error('navigator.gpu is unavailable');
      const gpuPrototype = Object.getPrototypeOf(gpu) as {
        requestAdapter: (...arguments_: unknown[]) => Promise<GPUAdapter | null>;
      };
      const originalRequestAdapter = gpuPrototype.requestAdapter;
      if (typeof originalRequestAdapter !== 'function') {
        throw new TypeError('GPU.requestAdapter is unavailable');
      }
      let adapterInstrumented = false;
      Object.defineProperty(gpuPrototype, 'requestAdapter', {
        configurable: true,
        writable: true,
        value: async function (this: GPU, ...arguments_: unknown[]) {
          const startedAtMs = performance.now();
          try {
            const adapter = await Reflect.apply(originalRequestAdapter, this, arguments_);
            recordRequestSpan(requestSpans.adapterRequests, {
              durationMs: performance.now() - startedAtMs,
              outcome: 'fulfilled',
            });
            if (adapter !== null && !adapterInstrumented) {
              try {
                const adapterPrototype = Object.getPrototypeOf(adapter) as {
                  requestDevice: (...deviceArguments: unknown[]) => Promise<GPUDevice>;
                };
                const originalRequestDevice = adapterPrototype.requestDevice;
                if (typeof originalRequestDevice !== 'function') {
                  throw new TypeError('GPUAdapter.requestDevice is unavailable');
                }
                Object.defineProperty(adapterPrototype, 'requestDevice', {
                  configurable: true,
                  writable: true,
                  value: async function (this: GPUAdapter, ...deviceArguments: unknown[]) {
                    const deviceStartedAtMs = performance.now();
                    try {
                      const device = await Reflect.apply(
                        originalRequestDevice,
                        this,
                        deviceArguments,
                      );
                      recordRequestSpan(requestSpans.deviceRequests, {
                        durationMs: performance.now() - deviceStartedAtMs,
                        outcome: 'fulfilled',
                      });
                      return device;
                    } catch (error: unknown) {
                      recordRequestSpan(requestSpans.deviceRequests, {
                        durationMs: performance.now() - deviceStartedAtMs,
                        outcome: 'rejected',
                      });
                      throw error;
                    }
                  },
                });
                adapterInstrumented = true;
              } catch {
                requestSpans.instrumentation = 'unavailable';
                requestSpans.unavailableReason =
                  'webgpu-request-device-method-instrumentation-unavailable';
              }
            }
            return adapter;
          } catch (error: unknown) {
            recordRequestSpan(requestSpans.adapterRequests, {
              durationMs: performance.now() - startedAtMs,
              outcome: 'rejected',
            });
            throw error;
          }
        },
      });
      requestSpans.instrumentation = 'installed';
    } catch {
      requestSpans.unavailableReason = 'webgpu-request-method-instrumentation-unavailable';
    }

    window.__p0LongTasks = [];
    window.__p0LongTaskObserverAvailable = false;
    if ('PerformanceObserver' in window) {
      try {
        new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) {
            if (entry.duration > 50) window.__p0LongTasks.push(entry.duration);
          }
        }).observe({ type: 'longtask', buffered: true });
        window.__p0LongTaskObserverAvailable = true;
      } catch {
        // Availability is recorded explicitly by the scenario.
      }
    }
  });

  const provenance = sourceProvenance();
  let snapshot = await prepare(page);
  const environmentValue = await environment(browser, page, testInfo.project.name, snapshot);
  Object.assign(environmentValue, {
    timezone: await page.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone),
  });
  const records: P0BenchmarkRecord[] = [];

  const startupRuns: P0BenchmarkRepetition[] = [];
  for (let index = 1; index <= settings.repetitions; index += 1) {
    const startedAtUtc = new Date().toISOString();
    await page.goto('/?surface=p0-reference-v1');
    await page.waitForFunction(() => window.__vectorStudioP0 !== undefined);
    let initializationMilestonesRejected = false;
    try {
      await page.evaluate(() => window.__vectorStudioP0.waitForInitializationMilestones());
    } catch {
      initializationMilestonesRejected = true;
    }
    const timing = await page.evaluate(() => window.__vectorStudioP0.getInitializationTiming());
    if (timing === undefined) throw new Error('Initialization ready timing is unavailable.');
    snapshot = await page.evaluate(() => window.__vectorStudioP0.snapshot());
    const startupSurface = snapshot.surfaceSize;
    if (startupSurface === undefined) throw new Error('Startup surface snapshot is unavailable.');
    expect(startupSurface).toMatchObject({
      devicePixelRatio: 1,
      physical: { width: 1280, height: 720 },
    });
    const requestSpans = await page.evaluate(
      () =>
        (
          window as unknown as Window & {
            __p0GpuRequestSpans: {
              adapterRequests: { durationMs: number; outcome: 'fulfilled' | 'rejected' }[];
              deviceRequests: { durationMs: number; outcome: 'fulfilled' | 'rejected' }[];
              instrumentation: 'installed' | 'unavailable';
              unavailableReason?: string;
            };
          }
        ).__p0GpuRequestSpans,
    );
    const adapterRequest = requestSpans.adapterRequests[0];
    const deviceRequest = requestSpans.deviceRequests[0];
    const samples = {
      navigationToReadyMs: [timing.navigationToReadyMs],
      initializationToReadyMs: [timing.initializationToReadyMs],
      firstSubmissionMs: timing.firstSubmissionMs === undefined ? [] : [timing.firstSubmissionMs],
      gpuCompletionMs: timing.gpuCompletionMs === undefined ? [] : [timing.gpuCompletionMs],
      adapterRequestMs: adapterRequest === undefined ? [] : [adapterRequest.durationMs],
      deviceRequestMs: deviceRequest === undefined ? [] : [deviceRequest.durationMs],
      actualPhysicalWidth: [startupSurface.physical.width],
      actualPhysicalHeight: [startupSurface.physical.height],
      actualDevicePixelRatio: [startupSurface.devicePixelRatio],
    };
    startupRuns.push({
      index,
      startedAtUtc,
      endedAtUtc: new Date().toISOString(),
      window: {
        clock: 'performance.now',
        startMs: timing.initializationStartedAtMs,
        endMs: timing.gpuCompletionAtMs ?? timing.firstSubmissionAtMs ?? timing.readyAtMs,
      },
      sampleCounts: Object.fromEntries(
        Object.entries(samples).map(([name, values]) => [name, values.length]),
      ),
      samples,
      metrics: {
        navigationToReady: available(
          timing.navigationToReadyMs,
          'ms',
          'performance.timeOrigin',
          'backend-ready',
          'playground initialization timing',
        ),
        initializationToReady: available(
          timing.initializationToReadyMs,
          'ms',
          'initialize-call',
          'backend-ready',
          'playground initialization timing',
        ),
        adapterRequest:
          adapterRequest?.outcome === 'fulfilled'
            ? available(
                adapterRequest.durationMs,
                'ms',
                'navigator.gpu.requestAdapter call',
                'native requestAdapter promise settlement',
                'test-only method wrapper using performance.now',
              )
            : unavailable(
                adapterRequest?.outcome === 'rejected'
                  ? 'adapter-request-rejected'
                  : (requestSpans.unavailableReason ?? 'adapter-request-not-observed'),
                'ms',
                'navigator.gpu.requestAdapter call',
                'native requestAdapter promise settlement',
              ),
        deviceRequest:
          deviceRequest?.outcome === 'fulfilled'
            ? available(
                deviceRequest.durationMs,
                'ms',
                'GPUAdapter.requestDevice call',
                'native requestDevice promise settlement',
                'test-only method wrapper using performance.now',
              )
            : unavailable(
                deviceRequest?.outcome === 'rejected'
                  ? 'device-request-rejected'
                  : (requestSpans.unavailableReason ?? 'device-request-not-observed'),
                'ms',
                'GPUAdapter.requestDevice call',
                'native requestDevice promise settlement',
              ),
        firstSubmission:
          timing.firstSubmissionMs === undefined
            ? unavailable(
                'initialization-first-submission-unavailable',
                'ms',
                'initialize-call',
                'framesSubmitted increment',
              )
            : available(
                timing.firstSubmissionMs,
                'ms',
                'initialize-call',
                'framesSubmitted increment',
                'backend statistics observation',
              ),
        gpuCompletion:
          timing.gpuCompletionMs === undefined
            ? unavailable(
                initializationMilestonesRejected
                  ? 'initialization-first-work-completion-rejected'
                  : 'initialization-first-work-completion-unavailable',
                'ms',
                'initialize-call',
                'GPUQueue.onSubmittedWorkDone resolution',
              )
            : available(
                timing.gpuCompletionMs,
                'ms',
                'initialize-call',
                'GPUQueue.onSubmittedWorkDone resolution',
                'queue completion promise for first submitted work',
              ),
        observedPresentation: unavailable(
          'browser-webgpu-no-presentation-timestamp',
          'ms',
          'initialize-call',
          'physical-display-presentation',
        ),
        actualPhysicalWidth: available(
          startupSurface.physical.width,
          'px',
          'backend-ready',
          'initial-surface-snapshot',
          'backend surface snapshot',
        ),
        actualPhysicalHeight: available(
          startupSurface.physical.height,
          'px',
          'backend-ready',
          'initial-surface-snapshot',
          'backend surface snapshot',
        ),
        actualDevicePixelRatio: available(
          startupSurface.devicePixelRatio,
          'ratio',
          'backend-ready',
          'initial-surface-snapshot',
          'backend surface snapshot',
        ),
      },
      diagnostics: diagnostics(snapshot),
    });
  }
  records.push(
    record(
      'p0/startup',
      2,
      json({
        repetitions: settings.repetitions,
        workload: FOUNDATION_WORKLOAD,
        referenceSurface: REFERENCE_SURFACE_CONFIGURATION,
        mode: 'on-demand',
        warmupDurationMs: 0,
        measurementWindow: {
          kind: 'fresh-navigation-event-bounded',
          endEvent: 'first submitted GPU work queue completion',
        },
        surfaceFixture: 'p0-reference-v1',
        timingEndpoints: {
          navigationReady: {
            clock: 'performance.now',
            startEvent: 'performance.timeOrigin',
            endEvent: 'backend-ready',
          },
          initializationReady: {
            clock: 'performance.now',
            startEvent: 'initialize-call',
            endEvent: 'backend-ready',
          },
          firstSubmission: {
            clock: 'performance.now',
            startEvent: 'initialize-call',
            endEvent: 'framesSubmitted increment',
          },
          firstWorkGpuCompletion: {
            clock: 'performance.now',
            startEvent: 'initialize-call',
            endEvent: 'GPUQueue.onSubmittedWorkDone resolution',
          },
          adapterRequest: {
            clock: 'performance.now',
            startEvent: 'navigator.gpu.requestAdapter call',
            endEvent: 'native requestAdapter promise settlement',
            observation: 'test-only method wrapper',
          },
          deviceRequest: {
            clock: 'performance.now',
            startEvent: 'GPUAdapter.requestDevice call',
            endEvent: 'native requestDevice promise settlement',
            observation: 'test-only method wrapper',
          },
          physicalPresentation: {
            availability: 'unavailable',
            reason: 'browser-webgpu-no-presentation-timestamp',
          },
        },
        acceptance: {
          navigationReady: { aggregation: 'p95-nearest-rank', ceilingMs: 1000 },
          firstWorkGpuCompletion: { aggregation: 'p95-nearest-rank', ceilingMs: 1200 },
        },
        instrumentationOverhead:
          'two performance.now calls and one promise continuation per wrapped request',
      }),
      startupRuns,
      environmentValue,
      provenance,
    ),
  );

  const steadyRuns: P0BenchmarkRepetition[] = [];
  for (let index = 1; index <= settings.repetitions; index += 1) {
    await prepare(page);
    const startedAtUtc = new Date().toISOString();
    await page.evaluate(() => window.__vectorStudioP0.setMode('continuous'));
    await page.waitForTimeout(settings.steadyWarmupMs);
    const baseline = await page.evaluate(() => {
      window.__p0LongTasks = [];
      window.__vectorStudioP0.startFrameMeasurements();
      return window.__vectorStudioP0.snapshot();
    });
    await page.waitForTimeout(settings.steadyMeasuredMs);
    const measured = await page.evaluate(() => {
      window.__vectorStudioP0.setMode('on-demand');
      return {
        measurements: window.__vectorStudioP0.stopFrameMeasurements(),
        snapshot: window.__vectorStudioP0.snapshot(),
        longTasks: [...window.__p0LongTasks],
        longTaskObserverAvailable: window.__p0LongTaskObserverAvailable,
      };
    });
    const frameP95 = percentile(measured.measurements.frameIntervalsMs, 0.95);
    const cpuP95 = percentile(measured.measurements.encodeAndSubmitMs, 0.95);
    steadyRuns.push({
      index,
      startedAtUtc,
      endedAtUtc: new Date().toISOString(),
      window: {
        clock: 'performance.now',
        startMs: measured.measurements.startedAtMs ?? 0,
        endMs: measured.measurements.endedAtMs ?? 0,
      },
      sampleCounts: {
        frameIntervalMs: measured.measurements.frameIntervalsMs.length,
        encodeAndSubmitMs: measured.measurements.encodeAndSubmitMs.length,
        longTaskMs: measured.longTasks.length,
      },
      samples: {
        frameIntervalMs: measured.measurements.frameIntervalsMs,
        encodeAndSubmitMs: measured.measurements.encodeAndSubmitMs,
        longTaskMs: measured.longTasks,
      },
      metrics: {
        frameIntervalMedian: available(
          percentile(measured.measurements.frameIntervalsMs, 0.5),
          'ms',
          'previous-animation-frame',
          'animation-frame',
          'requestAnimationFrame callback interval',
        ),
        frameIntervalP95: available(
          frameP95,
          'ms',
          'previous-animation-frame',
          'animation-frame',
          'requestAnimationFrame callback interval',
        ),
        frameIntervalP99: available(
          percentile(measured.measurements.frameIntervalsMs, 0.99),
          'ms',
          'previous-animation-frame',
          'animation-frame',
          'requestAnimationFrame callback interval',
        ),
        cpuEncodeAndSubmitMedian: available(
          percentile(measured.measurements.encodeAndSubmitMs, 0.5),
          'ms',
          'render-encode-start',
          'queue-submit-return',
          'backend CPU clock',
        ),
        cpuEncodeAndSubmitP95: available(
          cpuP95,
          'ms',
          'render-encode-start',
          'queue-submit-return',
          'backend CPU clock',
        ),
        cpuEncodeAndSubmitP99: available(
          percentile(measured.measurements.encodeAndSubmitMs, 0.99),
          'ms',
          'render-encode-start',
          'queue-submit-return',
          'backend CPU clock',
        ),
        longTasksOver50Ms: measured.longTaskObserverAvailable
          ? available(
              measured.longTasks.length,
              'count',
              'measurement-window-start',
              'measurement-window-end',
              'PerformanceObserver longtask entries',
            )
          : unavailable(
              'performance-longtask-observer-unsupported',
              'count',
              'measurement-window-start',
              'measurement-window-end',
            ),
        pipelineCreations: available(
          measured.snapshot.statistics.pipelinesCreated - baseline.statistics.pipelinesCreated,
          'count',
          'measurement-window-start',
          'measurement-window-end',
          'engine resource counters',
        ),
        shaderCreations: available(
          measured.snapshot.statistics.shaderModulesCreated -
            baseline.statistics.shaderModulesCreated,
          'count',
          'measurement-window-start',
          'measurement-window-end',
          'engine resource counters',
        ),
        peakTrackedGpuBytes: available(
          measured.snapshot.statistics.resources.peakLiveBytes,
          'bytes',
          'backend-instance-created',
          'measurement-window-end',
          'engine-accounted resource bytes',
        ),
        droppedFrameIntervalSamples: available(
          measured.measurements.droppedSamples.frameIntervalsMs,
          'count',
          'measurement-window-start',
          'measurement-window-end',
          'bounded measurement storage',
        ),
        droppedEncodeAndSubmitSamples: available(
          measured.measurements.droppedSamples.encodeAndSubmitMs,
          'count',
          'measurement-window-start',
          'measurement-window-end',
          'bounded measurement storage',
        ),
      },
      diagnostics: diagnostics(measured.snapshot),
    });
  }
  records.push(
    record(
      'p0/steady-foundation',
      1,
      json({
        repetitions: settings.repetitions,
        workload: FOUNDATION_WORKLOAD,
        referenceSurface: REFERENCE_SURFACE_CONFIGURATION,
        mode: 'continuous',
        warmupDurationMs: settings.steadyWarmupMs,
        measuredDurationMs: settings.steadyMeasuredMs,
        measurementCapacity: MEASUREMENT_CAPACITY,
      }),
      steadyRuns,
      environmentValue,
      provenance,
    ),
  );

  const idleRuns: P0BenchmarkRepetition[] = [];
  for (let index = 1; index <= settings.repetitions; index += 1) {
    snapshot = await prepare(page);
    const startedAtUtc = new Date().toISOString();
    const windowStart = await page.evaluate(() => performance.now());
    const baseline = snapshot.statistics.framesSubmitted;
    await page.evaluate(() => {
      for (let count = 0; count < 100; count += 1) window.__vectorStudioP0.invalidate();
    });
    await page.waitForFunction(
      (submitted) =>
        window.__vectorStudioP0.snapshot().statistics.framesSubmitted === submitted + 1,
      baseline,
    );
    const settled = await page.evaluate(() => window.__vectorStudioP0.snapshot());
    await page.waitForTimeout(settings.idleObservedMs);
    const idle = await page.evaluate(() => window.__vectorStudioP0.snapshot());
    const windowEnd = await page.evaluate(() => performance.now());
    await page.evaluate(() => window.__vectorStudioP0.dispose());
    const disposed = await page.evaluate(() => window.__vectorStudioP0.snapshot());
    const values = [
      settled.statistics.framesSubmitted - baseline,
      idle.statistics.framesSubmitted - settled.statistics.framesSubmitted,
      disposed.statistics.pendingFrameCallbacks,
    ];
    idleRuns.push({
      index,
      startedAtUtc,
      endedAtUtc: new Date().toISOString(),
      window: { clock: 'performance.now', startMs: windowStart, endMs: windowEnd },
      ...metricSamples('invariants', values),
      metrics: {
        burstSubmissions: available(
          values[0] ?? 0,
          'count',
          'burst-start',
          'burst-settled',
          'backend statistics',
        ),
        idleSubmissions: available(
          values[1] ?? 0,
          'count',
          'idle-start',
          'idle-end',
          'backend statistics',
        ),
        pendingCallbacksAfterDispose: available(
          values[2] ?? 0,
          'count',
          'dispose-call',
          'dispose-return',
          'scheduler statistics',
        ),
      },
      diagnostics: diagnostics(idle),
    });
  }
  records.push(
    record(
      'p0/idle-invalidation',
      1,
      json({
        repetitions: settings.repetitions,
        workload: FOUNDATION_WORKLOAD,
        referenceSurface: REFERENCE_SURFACE_CONFIGURATION,
        mode: 'on-demand',
        warmupDurationMs: 0,
        burstInvalidations: 100,
        idleObservationMs: settings.idleObservedMs,
        measurementWindow: {
          kind: 'fixed-duration-after-burst-settlement',
          durationMs: settings.idleObservedMs,
        },
      }),
      idleRuns,
      environmentValue,
      provenance,
    ),
  );

  const resizeRuns: P0BenchmarkRepetition[] = [];
  for (let index = 1; index <= settings.repetitions; index += 1) {
    await prepare(page);
    const startedAtUtc = new Date().toISOString();
    await page.evaluate(() => window.__vectorStudioP0.startFrameMeasurements());
    const maximumSubmissions = await page.evaluate(
      async ({ steps, sequence, finalSurface }) => {
        let previous = window.__vectorStudioP0.snapshot().statistics.framesSubmitted;
        let maximum = 0;
        for (let step = 0; step < steps; step += 1) {
          const width =
            sequence.width.base + ((step * sequence.width.stepMultiplier) % sequence.width.modulus);
          const height =
            sequence.height.base +
            ((step * sequence.height.stepMultiplier) % sequence.height.modulus);
          const devicePixelRatio =
            sequence.devicePixelRatios[step % sequence.devicePixelRatios.length] ??
            sequence.devicePixelRatios[0];
          window.__vectorStudioP0.resize(width, height, devicePixelRatio);
          await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
          const current = window.__vectorStudioP0.snapshot().statistics.framesSubmitted;
          maximum = Math.max(maximum, current - previous);
          previous = current;
        }
        window.__vectorStudioP0.resize(
          finalSurface.cssSize[0],
          finalSurface.cssSize[1],
          finalSurface.devicePixelRatio,
        );
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        return maximum;
      },
      {
        steps: settings.resizeSteps,
        sequence: RESIZE_SEQUENCE,
        finalSurface: REFERENCE_SURFACE_CONFIGURATION,
      },
    );
    const result = await page.evaluate(() => ({
      measurements: window.__vectorStudioP0.stopFrameMeasurements(),
      snapshot: window.__vectorStudioP0.snapshot(),
    }));
    const cpuP95 = percentile(result.measurements.encodeAndSubmitMs, 0.95);
    const values = [
      ...result.measurements.encodeAndSubmitMs,
      maximumSubmissions,
      result.snapshot.surfaceSize?.physical.width ?? 0,
      result.snapshot.surfaceSize?.physical.height ?? 0,
    ];
    resizeRuns.push({
      index,
      startedAtUtc,
      endedAtUtc: new Date().toISOString(),
      window: {
        clock: 'performance.now',
        startMs: result.measurements.startedAtMs ?? 0,
        endMs: result.measurements.endedAtMs ?? 0,
      },
      ...metricSamples('resizeObservations', values),
      metrics: {
        cpuEncodeAndSubmitMedian: available(
          percentile(result.measurements.encodeAndSubmitMs, 0.5),
          'ms',
          'render-encode-start',
          'queue-submit-return',
          'backend CPU clock',
        ),
        cpuEncodeAndSubmitP95: available(
          cpuP95,
          'ms',
          'render-encode-start',
          'queue-submit-return',
          'backend CPU clock',
        ),
        cpuEncodeAndSubmitP99: available(
          percentile(result.measurements.encodeAndSubmitMs, 0.99),
          'ms',
          'render-encode-start',
          'queue-submit-return',
          'backend CPU clock',
        ),
        maximumSubmissionsPerAnimationFrame: available(
          maximumSubmissions,
          'count',
          'resize-before-animation-frame',
          'animation-frame',
          'backend statistics delta',
        ),
        liveSizeDependentAttachments: available(
          result.snapshot.statistics.resources.byCategory.texture?.live ?? 0,
          'count',
          'resize-storm-start',
          'resize-settled',
          'engine texture resource counter',
        ),
        finalPhysicalWidth: available(
          result.snapshot.surfaceSize?.physical.width ?? 0,
          'px',
          'resize-storm-start',
          'resize-settled',
          'surface snapshot',
        ),
        finalPhysicalHeight: available(
          result.snapshot.surfaceSize?.physical.height ?? 0,
          'px',
          'resize-storm-start',
          'resize-settled',
          'surface snapshot',
        ),
        droppedFrameIntervalSamples: available(
          result.measurements.droppedSamples.frameIntervalsMs,
          'count',
          'measurement-window-start',
          'measurement-window-end',
          'bounded measurement storage',
        ),
        droppedEncodeAndSubmitSamples: available(
          result.measurements.droppedSamples.encodeAndSubmitMs,
          'count',
          'measurement-window-start',
          'measurement-window-end',
          'bounded measurement storage',
        ),
      },
      diagnostics: diagnostics(result.snapshot),
    });
  }
  records.push(
    record(
      'p0/resize-storm',
      1,
      json({
        repetitions: settings.repetitions,
        workload: FOUNDATION_WORKLOAD,
        mode: 'on-demand',
        warmupDurationMs: 0,
        measurementCapacity: MEASUREMENT_CAPACITY,
        steps: settings.resizeSteps,
        sequence: RESIZE_SEQUENCE,
        initialSurface: REFERENCE_SURFACE_CONFIGURATION,
        finalSurface: REFERENCE_SURFACE_CONFIGURATION,
        measurementWindow: { kind: 'operation-bounded', operations: settings.resizeSteps },
      }),
      resizeRuns,
      environmentValue,
      provenance,
    ),
  );

  const lifecycleRuns: P0BenchmarkRepetition[] = [];
  for (let index = 1; index <= settings.repetitions; index += 1) {
    const initialLifecycleSnapshot = await prepare(page, '/?surface=p0-reference-v1');
    const initialLifecycleSurface = initialLifecycleSnapshot.surfaceSize;
    if (initialLifecycleSurface === undefined) {
      throw new Error('Initial lifecycle surface snapshot is unavailable.');
    }
    expect(initialLifecycleSurface).toMatchObject({
      devicePixelRatio: 1,
      physical: { width: 1280, height: 720 },
    });
    const startedAtUtc = new Date().toISOString();
    const disposedLiveResources: number[] = [];
    const disposedDiagnosticListeners: number[] = [];
    const disposedPendingCallbacks: number[] = [];
    const initializedPhysicalWidths = [initialLifecycleSurface.physical.width];
    const initializedPhysicalHeights = [initialLifecycleSurface.physical.height];
    const initializedDevicePixelRatios = [initialLifecycleSurface.devicePixelRatio];
    for (let cycle = 0; cycle < settings.lifecycleCycles; cycle += 1) {
      await page.evaluate(() => window.__vectorStudioP0.reinitialize());
      await page.evaluate(() => window.__vectorStudioP0.waitForInitializationMilestones());
      const initialized = await page.evaluate(() => window.__vectorStudioP0.snapshot());
      const initializedSurface = initialized.surfaceSize;
      if (initializedSurface === undefined) {
        throw new Error('Lifecycle cycle surface snapshot is unavailable.');
      }
      expect(initializedSurface).toMatchObject({
        devicePixelRatio: 1,
        physical: { width: 1280, height: 720 },
      });
      initializedPhysicalWidths.push(initializedSurface.physical.width);
      initializedPhysicalHeights.push(initializedSurface.physical.height);
      initializedDevicePixelRatios.push(initializedSurface.devicePixelRatio);
      await page.evaluate(() => window.__vectorStudioP0.dispose());
      const disposed = await page.evaluate(() => window.__vectorStudioP0.snapshot());
      disposedLiveResources.push(disposed.statistics.resources.live);
      disposedDiagnosticListeners.push(disposed.statistics.diagnosticListeners);
      disposedPendingCallbacks.push(disposed.statistics.pendingFrameCallbacks);
    }
    await page.evaluate(() => window.__vectorStudioP0.reinitialize());
    await page.evaluate(() => window.__vectorStudioP0.waitForInitializationMilestones());
    const beforeLoss = await page.evaluate(() => window.__vectorStudioP0.snapshot());
    const beforeLossSurface = beforeLoss.surfaceSize;
    if (beforeLossSurface === undefined) {
      throw new Error('Pre-loss lifecycle surface snapshot is unavailable.');
    }
    expect(beforeLossSurface).toMatchObject({
      devicePixelRatio: 1,
      physical: { width: 1280, height: 720 },
    });
    initializedPhysicalWidths.push(beforeLossSurface.physical.width);
    initializedPhysicalHeights.push(beforeLossSurface.physical.height);
    initializedDevicePixelRatios.push(beforeLossSurface.devicePixelRatio);
    await page.evaluate(() => window.__vectorStudioP0.destroyDeviceForTesting());
    await page.waitForFunction(
      ({ generation, submitted }) => {
        const current = window.__vectorStudioP0.snapshot();
        return (
          current.state === 'ready' &&
          current.statistics.generation === generation + 1 &&
          current.statistics.framesSubmitted > submitted
        );
      },
      {
        generation: beforeLoss.statistics.generation,
        submitted: beforeLoss.statistics.framesSubmitted,
      },
    );
    const recoveredSubmissionAtMs = await page.evaluate(() => performance.now());
    const completionObservation = await page.evaluate(async () => {
      try {
        await window.__vectorStudioP0.waitForSubmittedWork();
        return { atMs: performance.now(), outcome: 'fulfilled' as const };
      } catch {
        return { atMs: performance.now(), outcome: 'rejected' as const };
      }
    });
    const recovered = await page.evaluate(() => window.__vectorStudioP0.snapshot());
    const recoveredSurface = recovered.surfaceSize;
    if (recoveredSurface === undefined) {
      throw new Error('Recovered surface snapshot is unavailable.');
    }
    expect(recoveredSurface).toMatchObject({
      devicePixelRatio: 1,
      physical: { width: 1280, height: 720 },
    });
    initializedPhysicalWidths.push(recoveredSurface.physical.width);
    initializedPhysicalHeights.push(recoveredSurface.physical.height);
    initializedDevicePixelRatios.push(recoveredSurface.devicePixelRatio);
    const lossTimestamp = recovered.diagnostics.find(({ code }) => code === 'device-loss.detected');
    const successTimestamp = recovered.diagnostics.find(
      ({ code }) => code === 'recovery.succeeded',
    );
    const lossTime = Number(lossTimestamp?.timestampMs);
    const successTime = Number(successTimestamp?.timestampMs);
    if (!Number.isFinite(lossTime) || !Number.isFinite(successTime)) {
      throw new Error('Recovery diagnostic timestamps are unavailable.');
    }
    const samples = {
      disposedLiveResources,
      disposedDiagnosticListeners,
      disposedPendingCallbacks,
      recoveryReadyMs: [successTime - lossTime],
      recoveryFirstSubmissionMs: [recoveredSubmissionAtMs - lossTime],
      recoveryGpuCompletionMs:
        completionObservation.outcome === 'fulfilled'
          ? [completionObservation.atMs - lossTime]
          : [],
      initializedPhysicalWidths,
      initializedPhysicalHeights,
      initializedDevicePixelRatios,
    };
    lifecycleRuns.push({
      index,
      startedAtUtc,
      endedAtUtc: new Date().toISOString(),
      window: {
        clock: 'performance.now',
        startMs: lossTime,
        endMs: completionObservation.atMs,
      },
      sampleCounts: Object.fromEntries(
        Object.entries(samples).map(([name, values]) => [name, values.length]),
      ),
      samples,
      metrics: {
        maximumLiveResourcesAfterDispose: available(
          Math.max(...disposedLiveResources),
          'count',
          'cycle-dispose',
          'cycle-snapshot',
          'engine resource counters',
        ),
        maximumDiagnosticListenersAfterDispose: available(
          Math.max(...disposedDiagnosticListeners),
          'count',
          'cycle-dispose',
          'cycle-snapshot',
          'diagnostic channel count',
        ),
        maximumPendingCallbacksAfterDispose: available(
          Math.max(...disposedPendingCallbacks),
          'count',
          'cycle-dispose',
          'cycle-snapshot',
          'scheduler statistics',
        ),
        recoveryReady: available(
          successTime - lossTime,
          'ms',
          'device-loss.detected',
          'recovery.succeeded',
          'diagnostic monotonic timestamps',
        ),
        recoveryFirstSubmission: available(
          recoveredSubmissionAtMs - lossTime,
          'ms',
          'device-loss.detected',
          'rebuilt-generation framesSubmitted increment',
          'backend statistics observation',
        ),
        recoveryGpuCompletion:
          completionObservation.outcome === 'fulfilled'
            ? available(
                completionObservation.atMs - lossTime,
                'ms',
                'device-loss.detected',
                'GPUQueue.onSubmittedWorkDone resolution',
                'queue completion promise; timestamp sampled in the resolving page task is a conservative observation upper bound',
              )
            : unavailable(
                'recovery-first-work-completion-rejected',
                'ms',
                'device-loss.detected',
                'GPUQueue.onSubmittedWorkDone resolution',
              ),
        observedPresentation: unavailable(
          'browser-webgpu-no-presentation-timestamp',
          'ms',
          'device-loss.detected',
          'physical-display-presentation',
        ),
        recoveryAttempts: available(
          recovered.statistics.recoveryAttempts,
          'count',
          'device-loss.detected',
          'recovery.succeeded',
          'backend statistics',
        ),
        staleGenerationSubmissions: available(
          recovered.statistics.staleGenerationSubmissions,
          'count',
          'device-loss.detected',
          'recovery.succeeded',
          'diagnostic counter; deterministic spy evidence is separate',
        ),
        actualPhysicalWidth: available(
          recoveredSurface.physical.width,
          'px',
          'recovery.succeeded',
          'recovered-surface-snapshot',
          'backend surface snapshot',
        ),
        actualPhysicalHeight: available(
          recoveredSurface.physical.height,
          'px',
          'recovery.succeeded',
          'recovered-surface-snapshot',
          'backend surface snapshot',
        ),
        actualDevicePixelRatio: available(
          recoveredSurface.devicePixelRatio,
          'ratio',
          'recovery.succeeded',
          'recovered-surface-snapshot',
          'backend surface snapshot',
        ),
      },
      diagnostics: diagnostics(recovered, [
        'device-loss.detected',
        'recovery.started',
        'recovery.succeeded',
      ]),
    });
  }
  records.push(
    record(
      'p0/lifecycle-recovery',
      2,
      json({
        repetitions: settings.repetitions,
        workload: FOUNDATION_WORKLOAD,
        referenceSurface: REFERENCE_SURFACE_CONFIGURATION,
        mode: 'on-demand',
        warmupDurationMs: 0,
        measurementWindow: {
          kind: 'cycles-then-loss-recovery-event-bounded',
          cycles: settings.lifecycleCycles,
          endEvent: 'rebuilt GPU work queue completion',
        },
        initializeRenderDisposeCycles: settings.lifecycleCycles,
        deliberateLossesPerRepetition: 1,
        surfaceFixture: 'p0-reference-v1',
        timingEndpoints: {
          recoveryReady: {
            clock: 'performance.now',
            startEvent: 'device-loss.detected',
            endEvent: 'recovery.succeeded',
          },
          firstRebuiltSubmission: {
            clock: 'performance.now',
            startEvent: 'device-loss.detected',
            endEvent: 'rebuilt-generation framesSubmitted increment',
          },
          rebuiltWorkGpuCompletion: {
            clock: 'performance.now',
            startEvent: 'device-loss.detected',
            endEvent: 'GPUQueue.onSubmittedWorkDone resolution',
            observation: 'completion timestamp sampled in the resolving page task; upper bound',
          },
          physicalPresentation: {
            availability: 'unavailable',
            reason: 'browser-webgpu-no-presentation-timestamp',
          },
        },
        acceptance: {
          recoveryReady: { aggregation: 'every-repetition', ceilingMs: 3000 },
          rebuiltWorkGpuCompletion: { aggregation: 'every-repetition', ceilingMs: 3000 },
        },
      }),
      lifecycleRuns,
      environmentValue,
      provenance,
    ),
  );

  expect(records.map(({ scenario }) => `${scenario.id}/v${scenario.version}`)).toEqual([
    'p0/startup/v2',
    'p0/steady-foundation/v1',
    'p0/idle-invalidation/v1',
    'p0/resize-storm/v1',
    'p0/lifecycle-recovery/v2',
  ]);
  for (const benchmarkRecord of records) {
    expect(validateP0BenchmarkRecord(benchmarkRecord)).toEqual([]);
    await writeP0BenchmarkArtifacts(
      benchmarkRecord,
      outputDirectory,
      testInfo.project.name,
      os.hostname(),
    );
  }
});
