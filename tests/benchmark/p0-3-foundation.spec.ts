import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { expect, test, type Browser, type Page } from '@playwright/test';
import type { PlaygroundSnapshot } from '../support/playground-api.js';
import '../support/playground-api.js';

interface SteadyRun {
  readonly frameIntervalMinMs: number;
  readonly frameIntervalMedianMs: number;
  readonly frameIntervalP95Ms: number;
  readonly frameIntervalP99Ms: number;
  readonly frameIntervalMaxMs: number;
  readonly cpuSubmitMinMs: number;
  readonly cpuSubmitMedianMs: number;
  readonly cpuSubmitP95Ms: number;
  readonly cpuSubmitP99Ms: number;
  readonly cpuSubmitMaxMs: number;
  readonly frameIntervalSamples: number;
  readonly cpuSubmitSamples: number;
  readonly longTasksOver50Ms: number;
  readonly pipelineCreations: number;
  readonly shaderCreations: number;
  readonly peakTrackedGpuBytes: number;
  readonly framesSubmitted: number;
}

interface IdleRun {
  readonly burstSubmissions: number;
  readonly idleSubmissions: number;
  readonly pendingCallbacksAfterDispose: number;
}

const resultDirectory = path.resolve('docs/benchmarks/results');
const repetitions = 5;
const seed = 0;

function percentile(values: readonly number[], fraction: number): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)] ?? 0;
}

function fixed(value: number): number {
  return Number(value.toFixed(3));
}

function metricSummary(values: readonly number[]) {
  return {
    minMs: fixed(Math.min(...values)),
    medianMs: fixed(percentile(values, 0.5)),
    p95Ms: fixed(percentile(values, 0.95)),
    p99Ms: fixed(percentile(values, 0.99)),
    maxMs: fixed(Math.max(...values)),
  };
}

async function prepare(page: Page): Promise<PlaygroundSnapshot> {
  await page.goto('/');
  await page.waitForFunction(
    () => window.__vectorStudioP0?.snapshot().statistics.framesSubmitted >= 1,
  );
  await page.evaluate(() => window.__vectorStudioP0.resize(1280, 720, 1));
  await page.waitForFunction(
    () => window.__vectorStudioP0.snapshot().statistics.pendingFrameCallbacks === 0,
  );
  return page.evaluate(() => window.__vectorStudioP0.snapshot());
}

async function environment(
  browser: Browser,
  page: Page,
  projectName: string,
  snapshot: PlaygroundSnapshot,
) {
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
  const configuration = {
    physical: [1280, 720],
    dpr: 1,
    sampleCount: snapshot.capability.capabilities?.sampleCount,
  };
  return {
    revision: `${execFileSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim()}+dirty`,
    timestampUtc: new Date().toISOString(),
    localTimezone: browserEnvironment.timezone,
    buildMode: 'production',
    os: `${os.platform()} ${os.release()} ${os.arch()}`,
    cpu: os.cpus()[0]?.model ?? 'unavailable',
    logicalCores: os.cpus().length,
    installedMemoryBytes: os.totalmem(),
    browser: { product: projectName, channel: projectName, version: browser.version() },
    gpu: { ...(snapshot.capability.capabilities?.adapter ?? {}), driver: 'unavailable' },
    webGpuLimits: snapshot.capability.capabilities?.limits ?? {},
    viewport: { css: [1280, 720], physical: [1280, 720], devicePixelRatio: 1 },
    power: {
      source: browserEnvironment.powerSource,
      batteryLevel: browserEnvironment.batteryLevel,
      mode: 'unavailable',
    },
    knownBackgroundLoad: 'not audited; benchmark browsers only were intentionally launched',
    devTools: false,
    tracing: false,
    screenRecording: false,
    command: 'pnpm benchmark:p0:p0-3',
    runner: '@playwright/test 1.62.1; P0.3 fixed-scenario runner v1',
    configurationHash: createHash('sha256').update(JSON.stringify(configuration)).digest('hex'),
    hostReportedLogicalCores: browserEnvironment.hardwareConcurrency,
    hostReportedMemoryGiB: browserEnvironment.deviceMemoryGiB,
  };
}

function writeResult(
  projectName: string,
  scenarioSlug: string,
  payload: Record<string, unknown>,
  markdown: string,
): void {
  mkdirSync(resultDirectory, { recursive: true });
  const base = `2026-08-27_p0.3_${scenarioSlug}_${projectName}_reference`;
  writeFileSync(
    path.join(resultDirectory, `${base}.json`),
    `${JSON.stringify(payload, null, 2)}\n`,
  );
  writeFileSync(path.join(resultDirectory, `${base}.md`), markdown);
}

test('records the P0.3 steady and idle scenarios', async ({ browser, page }, testInfo) => {
  await page.addInitScript(() => {
    window.__p0LongTasks = [];
    if ('PerformanceObserver' in window) {
      try {
        new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) {
            if (entry.duration > 50) window.__p0LongTasks.push(entry.duration);
          }
        }).observe({ type: 'longtask', buffered: true });
      } catch {
        // Unsupported performance entry types are represented by an empty collection.
      }
    }
  });

  const initial = await prepare(page);
  expect(initial.capability.supported).toBe(true);
  const metadata = await environment(browser, page, testInfo.project.name, initial);
  const steadyRuns: SteadyRun[] = [];

  for (let repetition = 0; repetition < repetitions; repetition += 1) {
    if (repetition > 0) await prepare(page);
    await page.evaluate(() => window.__vectorStudioP0.setMode('continuous'));
    await page.waitForTimeout(3000);
    const baseline = await page.evaluate(() => {
      window.__p0LongTasks = [];
      window.__vectorStudioP0.startFrameMeasurements();
      return window.__vectorStudioP0.snapshot().statistics;
    });
    await page.waitForTimeout(10_000);
    await page.evaluate(() => window.__vectorStudioP0.setMode('on-demand'));
    await page.waitForTimeout(100);
    const measured = await page.evaluate(() => ({
      measurements: window.__vectorStudioP0.stopFrameMeasurements(),
      snapshot: window.__vectorStudioP0.snapshot(),
      longTasks: window.__p0LongTasks.length,
    }));
    const frameInterval = metricSummary(measured.measurements.frameIntervalsMs);
    const cpuSubmit = metricSummary(measured.measurements.encodeAndSubmitMs);
    steadyRuns.push({
      frameIntervalMinMs: frameInterval.minMs,
      frameIntervalMedianMs: frameInterval.medianMs,
      frameIntervalP95Ms: frameInterval.p95Ms,
      frameIntervalP99Ms: frameInterval.p99Ms,
      frameIntervalMaxMs: frameInterval.maxMs,
      cpuSubmitMinMs: cpuSubmit.minMs,
      cpuSubmitMedianMs: cpuSubmit.medianMs,
      cpuSubmitP95Ms: cpuSubmit.p95Ms,
      cpuSubmitP99Ms: cpuSubmit.p99Ms,
      cpuSubmitMaxMs: cpuSubmit.maxMs,
      frameIntervalSamples: measured.measurements.frameIntervalsMs.length,
      cpuSubmitSamples: measured.measurements.encodeAndSubmitMs.length,
      longTasksOver50Ms: measured.longTasks,
      pipelineCreations: measured.snapshot.statistics.pipelinesCreated - baseline.pipelinesCreated,
      shaderCreations:
        measured.snapshot.statistics.shaderModulesCreated - baseline.shaderModulesCreated,
      peakTrackedGpuBytes: measured.snapshot.statistics.resources.peakLiveBytes,
      framesSubmitted: measured.snapshot.statistics.framesSubmitted - baseline.framesSubmitted,
    });
  }

  const idleRuns: IdleRun[] = [];
  for (let repetition = 0; repetition < repetitions; repetition += 1) {
    await prepare(page);
    const baseline = await page.evaluate(() => {
      const before = window.__vectorStudioP0.snapshot().statistics.framesSubmitted;
      for (let index = 0; index < 100; index += 1) window.__vectorStudioP0.invalidate();
      return before;
    });
    await page.waitForFunction(
      (submitted) =>
        window.__vectorStudioP0.snapshot().statistics.framesSubmitted === submitted + 1,
      baseline,
    );
    const settled = await page.evaluate(
      () => window.__vectorStudioP0.snapshot().statistics.framesSubmitted,
    );
    await page.waitForTimeout(5000);
    const idleEnd = await page.evaluate(
      () => window.__vectorStudioP0.snapshot().statistics.framesSubmitted,
    );
    const pendingCallbacksAfterDispose = await page.evaluate(() => {
      window.__vectorStudioP0.dispose();
      return window.__vectorStudioP0.snapshot().statistics.pendingFrameCallbacks;
    });
    idleRuns.push({
      burstSubmissions: settled - baseline,
      idleSubmissions: idleEnd - settled,
      pendingCallbacksAfterDispose,
    });
  }

  const steadyAggregate = {
    frameIntervalP95Ms: fixed(
      percentile(
        steadyRuns.map((run) => run.frameIntervalP95Ms),
        0.95,
      ),
    ),
    cpuSubmitP95Ms: fixed(
      percentile(
        steadyRuns.map((run) => run.cpuSubmitP95Ms),
        0.95,
      ),
    ),
    longTasksOver50Ms: Math.max(...steadyRuns.map((run) => run.longTasksOver50Ms)),
    pipelineCreations: Math.max(...steadyRuns.map((run) => run.pipelineCreations)),
    shaderCreations: Math.max(...steadyRuns.map((run) => run.shaderCreations)),
    peakTrackedGpuBytes: Math.max(...steadyRuns.map((run) => run.peakTrackedGpuBytes)),
    repetitionP95Range: {
      frameIntervalMinMs: Math.min(...steadyRuns.map((run) => run.frameIntervalP95Ms)),
      frameIntervalMaxMs: Math.max(...steadyRuns.map((run) => run.frameIntervalP95Ms)),
      cpuSubmitMinMs: Math.min(...steadyRuns.map((run) => run.cpuSubmitP95Ms)),
      cpuSubmitMaxMs: Math.max(...steadyRuns.map((run) => run.cpuSubmitP95Ms)),
    },
  };
  const steadyPass =
    steadyAggregate.frameIntervalP95Ms <= 18 &&
    steadyAggregate.cpuSubmitP95Ms <= 2 &&
    steadyAggregate.longTasksOver50Ms === 0 &&
    steadyAggregate.pipelineCreations === 0 &&
    steadyAggregate.shaderCreations === 0 &&
    steadyAggregate.peakTrackedGpuBytes <= 32 * 1024 * 1024;
  const idlePass = idleRuns.every(
    (run) =>
      run.burstSubmissions === 1 &&
      run.idleSubmissions === 0 &&
      run.pendingCallbacksAfterDispose === 0,
  );

  const common = {
    metadata,
    seed,
    repetitions,
    sampleCount: initial.capability.capabilities?.sampleCount,
    diagnostics: initial.diagnostics,
  };
  writeResult(
    testInfo.project.name,
    'steady-foundation-v1',
    {
      scenario: 'p0/steady-foundation/v1',
      warmupMs: 3000,
      measuredMs: 10_000,
      ...common,
      runs: steadyRuns,
      aggregate: steadyAggregate,
      pass: steadyPass,
    },
    `# Benchmark result: P0.3 / steady foundation\n\nStatus: ${steadyPass ? 'Accepted' : 'Rejected'}\n\n## Identity\n\n- Revision: ${metadata.revision}\n- Timestamp UTC: ${metadata.timestampUtc}\n- Runner: ${metadata.runner}\n- Build mode: production\n\n## Environment\n\n- OS: ${metadata.os}\n- CPU / logical cores: ${metadata.cpu} / ${metadata.logicalCores}\n- Installed memory: ${metadata.installedMemoryBytes} bytes\n- GPU adapter: ${JSON.stringify(metadata.gpu)}\n- Browser / channel / version: ${testInfo.project.name} / ${testInfo.project.name} / ${browser.version()}\n- Viewport CSS / physical / DPR: 1280x720 / 1280x720 / 1\n- Power source and mode: ${metadata.power.source} / ${metadata.power.mode}\n- Known background load: ${metadata.knownBackgroundLoad}\n\n## Scenario\n\n- ID: \`p0/steady-foundation/v1\`\n- Seed: 0\n- Configuration hash: ${metadata.configurationHash}\n- Warm-up / measured / repetitions: 3000 ms / 10000 ms / 5\n- DevTools / tracing / recording: disabled / disabled / disabled\n\n## Results\n\n| Run | Frame min / median / p95 / p99 / max ms | CPU min / median / p95 / p99 / max ms | Samples frame / CPU | Long tasks | Pipeline / shader delta | Peak tracked bytes | Frames |\n| ---: | --- | --- | --- | ---: | ---: | ---: | ---: |\n${steadyRuns.map((run, index) => `| ${index + 1} | ${run.frameIntervalMinMs} / ${run.frameIntervalMedianMs} / ${run.frameIntervalP95Ms} / ${run.frameIntervalP99Ms} / ${run.frameIntervalMaxMs} | ${run.cpuSubmitMinMs} / ${run.cpuSubmitMedianMs} / ${run.cpuSubmitP95Ms} / ${run.cpuSubmitP99Ms} / ${run.cpuSubmitMaxMs} | ${run.frameIntervalSamples} / ${run.cpuSubmitSamples} | ${run.longTasksOver50Ms} | ${run.pipelineCreations} / ${run.shaderCreations} | ${run.peakTrackedGpuBytes} | ${run.framesSubmitted} |`).join('\n')}\n\nAcross-repetition p95 range: frame ${steadyAggregate.repetitionP95Range.frameIntervalMinMs}–${steadyAggregate.repetitionP95Range.frameIntervalMaxMs} ms; CPU ${steadyAggregate.repetitionP95Range.cpuSubmitMinMs}–${steadyAggregate.repetitionP95Range.cpuSubmitMaxMs} ms. Acceptance aggregate uses the worst per-run p95: frame **${steadyAggregate.frameIntervalP95Ms} ms**, CPU **${steadyAggregate.cpuSubmitP95Ms} ms**, long tasks **${steadyAggregate.longTasksOver50Ms}**, pipeline/shader delta **${steadyAggregate.pipelineCreations}/${steadyAggregate.shaderCreations}**, peak tracked bytes **${steadyAggregate.peakTrackedGpuBytes}**.\n\n## Acceptance evaluation\n\n- P0-A06 and \`p0/steady-foundation/v1\`: **${steadyPass ? 'PASS' : 'FAIL'}**\n\n## Artifacts\n\n- Raw JSON: matching \`.json\` file\n- Visual: \`docs/evidence/p0.3/foundation-${testInfo.project.name}.png\`\n`,
  );
  writeResult(
    testInfo.project.name,
    'idle-invalidation-v1',
    {
      scenario: 'p0/idle-invalidation/v1',
      measuredIdleMs: 5000,
      ...common,
      runs: idleRuns,
      pass: idlePass,
    },
    `# Benchmark result: P0.3 / idle invalidation\n\nStatus: ${idlePass ? 'Accepted' : 'Rejected'}\n\n## Identity\n\n- Revision: ${metadata.revision}\n- Timestamp UTC: ${metadata.timestampUtc}\n- Runner: ${metadata.runner}\n- Build mode: production\n\n## Environment\n\n- OS: ${metadata.os}\n- CPU / logical cores: ${metadata.cpu} / ${metadata.logicalCores}\n- Installed memory: ${metadata.installedMemoryBytes} bytes\n- GPU adapter: ${JSON.stringify(metadata.gpu)}\n- Browser / channel / version: ${testInfo.project.name} / ${testInfo.project.name} / ${browser.version()}\n- Viewport CSS / physical / DPR: 1280x720 / 1280x720 / 1\n- Power source and mode: ${metadata.power.source} / ${metadata.power.mode}\n- Known background load: ${metadata.knownBackgroundLoad}\n\n## Scenario\n\n- ID: \`p0/idle-invalidation/v1\`\n- Seed: 0\n- Configuration hash: ${metadata.configurationHash}\n- Idle observation / repetitions: 5000 ms / 5\n- DevTools / tracing / recording: disabled / disabled / disabled\n\n## Results\n\n| Run | Burst submissions | Idle submissions | Pending callbacks after dispose |\n| ---: | ---: | ---: | ---: |\n${idleRuns.map((run, index) => `| ${index + 1} | ${run.burstSubmissions} | ${run.idleSubmissions} | ${run.pendingCallbacksAfterDispose} |`).join('\n')}\n\n## Acceptance evaluation\n\n- P0-A05 and \`p0/idle-invalidation/v1\`: **${idlePass ? 'PASS' : 'FAIL'}**\n\n## Artifacts\n\n- Raw JSON: matching \`.json\` file\n`,
  );

  expect(steadyPass, JSON.stringify(steadyRuns)).toBe(true);
  expect(idlePass, JSON.stringify(idleRuns)).toBe(true);
});
