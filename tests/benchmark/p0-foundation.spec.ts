import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { expect, test, type Browser, type Page } from '@playwright/test';

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

async function prepare(page: Page): Promise<PlaygroundSnapshot> {
  await page.goto('/');
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
  const browserEnvironment = await page.evaluate(async () => {
    const navigatorWithBattery = navigator as Navigator & {
      deviceMemory?: number;
      getBattery?: () => Promise<{ charging: boolean; level: number }>;
    };
    const battery = await navigatorWithBattery.getBattery?.();
    return {
      hardwareConcurrency: navigator.hardwareConcurrency,
      deviceMemoryGiB: navigatorWithBattery.deviceMemory ?? null,
      powerSource:
        battery === undefined ? 'unavailable' : battery.charging ? 'AC/charging' : 'battery',
      batteryLevel: battery?.level ?? null,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    };
  });
  const refreshRate = Number(process.env.P0_DISPLAY_REFRESH_HZ);
  return {
    operatingSystem: `${os.platform()} ${os.release()} ${os.arch()}`,
    cpu: os.cpus()[0]?.model ?? 'unavailable',
    logicalCores: os.cpus().length,
    installedMemoryBytes: os.totalmem(),
    gpu: { ...(snapshot.capability.capabilities?.adapter ?? {}), driver: 'unavailable' },
    webGpuLimits: snapshot.capability.capabilities?.limits ?? {},
    browser: { product: projectName, channel: projectName, version: browser.version() },
    browserLaunchFlags: launchFlags,
    displayRefreshRate:
      Number.isFinite(refreshRate) && refreshRate > 0
        ? { availability: 'available', value: refreshRate, unit: 'Hz' }
        : { availability: 'unavailable', reason: 'P0_DISPLAY_REFRESH_HZ-not-provided' },
    selectedFeatures: snapshot.capability.capabilities?.selectedFeatures ?? [],
    sampleCount: snapshot.capability.capabilities?.sampleCount ?? 0,
    viewport: { css: [1280, 720], physical: [1280, 720], devicePixelRatio: 1 },
    power: {
      source: browserEnvironment.powerSource,
      batteryLevel: browserEnvironment.batteryLevel,
      mode: 'unavailable',
    },
    knownBackgroundLoad: 'not audited; benchmark browsers only were intentionally launched',
    hostReportedLogicalCores: browserEnvironment.hardwareConcurrency,
    hostReportedMemoryGiB: browserEnvironment.deviceMemoryGiB,
    devTools: false,
    tracing: false,
    screenRecording: false,
  };
}

function record(
  scenarioId: string,
  configuration: JsonValue,
  repetitions: readonly P0BenchmarkRepetition[],
  environmentValue: P0BenchmarkRecord['environment'],
  provenance: ReturnType<typeof sourceProvenance>,
): P0BenchmarkRecord {
  const timezone = environmentValue.timezone;
  const fullConfiguration = json({
    scenarioVersion: 1,
    seed: 0,
    profile,
    parameters: configuration,
  });
  const command = [
    'pnpm benchmark:p0 --',
    `--profile ${profile}`,
    `--output-dir ${JSON.stringify(outputDirectoryArgument)}`,
    ...(process.env.P0_DISPLAY_REFRESH_HZ === undefined
      ? []
      : [`--display-refresh-hz ${process.env.P0_DISPLAY_REFRESH_HZ}`]),
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
      version: 1,
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
    await page.goto('/');
    await page.waitForFunction(() => window.__vectorStudioP0 !== undefined);
    await page.evaluate(() => window.__vectorStudioP0.waitForInitializationMilestones());
    const timing = await page.evaluate(() => window.__vectorStudioP0.getInitializationTiming());
    if (timing?.firstSubmissionMs === undefined || timing.gpuCompletionMs === undefined) {
      throw new Error('Initialization milestones are incomplete.');
    }
    snapshot = await page.evaluate(() => window.__vectorStudioP0.snapshot());
    const samples = {
      navigationToReadyMs: [timing.navigationToReadyMs],
      initializationToReadyMs: [timing.initializationToReadyMs],
      firstSubmissionMs: [timing.firstSubmissionMs],
      gpuCompletionMs: [timing.gpuCompletionMs],
    };
    startupRuns.push({
      index,
      startedAtUtc,
      endedAtUtc: new Date().toISOString(),
      window: {
        clock: 'performance.now',
        startMs: timing.initializationStartedAtMs,
        endMs: timing.gpuCompletionAtMs ?? timing.readyAtMs,
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
        firstSubmission: available(
          timing.firstSubmissionMs,
          'ms',
          'initialize-call',
          'framesSubmitted increment',
          'backend statistics observation',
        ),
        gpuCompletion: available(
          timing.gpuCompletionMs,
          'ms',
          'initialize-call',
          'GPUQueue.onSubmittedWorkDone resolution',
          'queue completion promise',
        ),
        observedPresentation: unavailable(
          'browser-webgpu-no-presentation-timestamp',
          'ms',
          'initialize-call',
          'physical-display-presentation',
        ),
      },
      diagnostics: diagnostics(snapshot),
    });
  }
  records.push(
    record(
      'p0/startup',
      json({ repetitions: settings.repetitions, viewport: [1280, 720], devicePixelRatio: 1 }),
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
      json({
        repetitions: settings.repetitions,
        warmupDurationMs: settings.steadyWarmupMs,
        measuredDurationMs: settings.steadyMeasuredMs,
        measurementCapacity: 4096,
        viewport: [1280, 720],
        devicePixelRatio: 1,
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
      json({
        repetitions: settings.repetitions,
        burstInvalidations: 100,
        idleObservationMs: settings.idleObservedMs,
        viewport: [1280, 720],
        devicePixelRatio: 1,
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
    const maximumSubmissions = await page.evaluate(async (steps) => {
      let previous = window.__vectorStudioP0.snapshot().statistics.framesSubmitted;
      let maximum = 0;
      for (let step = 0; step < steps; step += 1) {
        const width = 900 + ((step * 37) % 380);
        const height = 500 + ((step * 23) % 220);
        window.__vectorStudioP0.resize(width, height, [1, 1.5, 2][step % 3] ?? 1);
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        const current = window.__vectorStudioP0.snapshot().statistics.framesSubmitted;
        maximum = Math.max(maximum, current - previous);
        previous = current;
      }
      window.__vectorStudioP0.resize(1280, 720, 1);
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      return maximum;
    }, settings.resizeSteps);
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
      json({
        repetitions: settings.repetitions,
        steps: settings.resizeSteps,
        pacing: 'one deterministic resize before each requestAnimationFrame',
        finalViewport: [1280, 720],
        finalDevicePixelRatio: 1,
      }),
      resizeRuns,
      environmentValue,
      provenance,
    ),
  );

  const lifecycleRuns: P0BenchmarkRepetition[] = [];
  for (let index = 1; index <= settings.repetitions; index += 1) {
    await prepare(page);
    const startedAtUtc = new Date().toISOString();
    const disposedLiveResources: number[] = [];
    const disposedDiagnosticListeners: number[] = [];
    const disposedPendingCallbacks: number[] = [];
    for (let cycle = 0; cycle < settings.lifecycleCycles; cycle += 1) {
      await page.evaluate(() => window.__vectorStudioP0.reinitialize());
      await page.evaluate(() => window.__vectorStudioP0.waitForInitializationMilestones());
      await page.evaluate(() => window.__vectorStudioP0.dispose());
      const disposed = await page.evaluate(() => window.__vectorStudioP0.snapshot());
      disposedLiveResources.push(disposed.statistics.resources.live);
      disposedDiagnosticListeners.push(disposed.statistics.diagnosticListeners);
      disposedPendingCallbacks.push(disposed.statistics.pendingFrameCallbacks);
    }
    await page.evaluate(() => window.__vectorStudioP0.reinitialize());
    await page.evaluate(() => window.__vectorStudioP0.waitForInitializationMilestones());
    const beforeLoss = await page.evaluate(() => window.__vectorStudioP0.snapshot());
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
    await page.evaluate(() => window.__vectorStudioP0.waitForSubmittedWork());
    const recoveredAtMs = await page.evaluate(() => performance.now());
    const recovered = await page.evaluate(() => window.__vectorStudioP0.snapshot());
    const lossTimestamp = recovered.diagnostics.find(({ code }) => code === 'device-loss.detected');
    const successTimestamp = recovered.diagnostics.find(
      ({ code }) => code === 'recovery.succeeded',
    );
    const lossTime = Number(lossTimestamp?.timestampMs);
    const successTime = Number(successTimestamp?.timestampMs);
    if (!Number.isFinite(lossTime) || !Number.isFinite(successTime)) {
      throw new Error('Recovery diagnostic timestamps are unavailable.');
    }
    const samples = [
      ...disposedLiveResources,
      ...disposedDiagnosticListeners,
      ...disposedPendingCallbacks,
      successTime - lossTime,
      recoveredSubmissionAtMs - lossTime,
      recoveredAtMs - lossTime,
    ];
    lifecycleRuns.push({
      index,
      startedAtUtc,
      endedAtUtc: new Date().toISOString(),
      window: { clock: 'performance.now', startMs: lossTime, endMs: recoveredAtMs },
      ...metricSamples('lifecycleObservations', samples),
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
        recoveryGpuCompletion: available(
          recoveredAtMs - lossTime,
          'ms',
          'device-loss.detected',
          'GPUQueue.onSubmittedWorkDone resolution',
          'queue completion promise',
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
      json({
        repetitions: settings.repetitions,
        initializeRenderDisposeCycles: settings.lifecycleCycles,
        deliberateLossesPerRepetition: 1,
        viewport: [1280, 720],
        devicePixelRatio: 1,
      }),
      lifecycleRuns,
      environmentValue,
      provenance,
    ),
  );

  expect(records.map(({ scenario }) => `${scenario.id}/v${scenario.version}`)).toEqual([
    'p0/startup/v1',
    'p0/steady-foundation/v1',
    'p0/idle-invalidation/v1',
    'p0/resize-storm/v1',
    'p0/lifecycle-recovery/v1',
  ]);
  for (const benchmarkRecord of records) {
    expect(validateP0BenchmarkRecord(benchmarkRecord)).toEqual([]);
    writeP0BenchmarkArtifacts(
      benchmarkRecord,
      outputDirectory,
      testInfo.project.name,
      os.hostname(),
    );
  }
});
