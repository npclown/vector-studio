import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { RendererStatistics } from '@vector-studio/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { P1FunctionalCapture } from '../../apps/playground/src/p1-runner.js';
import {
  type P1FrameObservation,
  zeroP1CpuStatistics,
} from '../../apps/playground/src/p1-run-metrics.js';
import {
  P1_PROFILES,
  p1RunConfiguration,
  summarizeP1RunFrames,
  type P1ProfileName,
} from '../../apps/playground/src/p1-run-profiles.js';
import {
  P1_CONFIGURATION,
  P1_SCENARIOS,
  type P1Scenario,
} from '../../apps/playground/src/p1-workloads.js';
import { p1Hash, createP1FunctionalRecord, type P1Source } from '../support/p1-runner-record.js';
import { aggregateP1Records, writeP1Aggregate } from '../support/p1-runner-aggregate.js';

const temporaryDirectories: string[] = [];
const originalEnvironment = {
  command: process.env.P1_RUNNER_COMMAND,
  buildMode: process.env.P1_RUNNER_BUILD_MODE,
  environment: process.env.P1_RUNNER_ENVIRONMENT,
};
const referenceEnvironment = {
  observedAt: '2026-09-26T12:00:00+09:00',
  displayRefreshHz: { value: 60, source: 'display settings' },
  power: { value: 'AC', source: 'operator observation' },
  backgroundLoad: { value: 'idle', source: 'task manager' },
  driver: { value: 'test-driver', source: 'adapter utility' },
  display: { value: 'primary 1920x1080@60', source: 'display settings' },
};
const browsers = ['chrome', 'edge'] as const;

beforeEach(() => {
  process.env.P1_RUNNER_COMMAND = JSON.stringify([
    'pnpm',
    'benchmark:p1',
    '--profile',
    'reference',
  ]);
  process.env.P1_RUNNER_BUILD_MODE = 'production';
  process.env.P1_RUNNER_ENVIRONMENT = JSON.stringify(referenceEnvironment);
});

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0))
    rmSync(directory, { recursive: true, force: true });
  restoreEnvironment('P1_RUNNER_COMMAND', originalEnvironment.command);
  restoreEnvironment('P1_RUNNER_BUILD_MODE', originalEnvironment.buildMode);
  restoreEnvironment('P1_RUNNER_ENVIRONMENT', originalEnvironment.environment);
});

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function temporaryRoot(): string {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'vector-studio-p1-aggregate-'));
  temporaryDirectories.push(directory);
  return directory;
}

function source(suffix = 'a'): P1Source {
  const sha256 = suffix.repeat(64).slice(0, 64);
  return {
    baseCommit: suffix.repeat(40).slice(0, 40),
    worktree: '',
    files: [{ path: 'apps/playground/src/p1-runner.ts', sha256 }],
    manifestSha256: sha256,
  };
}

function disposedStatistics(): RendererStatistics {
  const empty = { created: 0, live: 0, liveBytes: 0, peakLiveBytes: 0 };
  return {
    lifecycle: 'disposed',
    generation: 1,
    mode: 'on-demand',
    invalidationsRequested: 8,
    framesSubmitted: 8,
    framesPresented: 8,
    pendingFrameCallbacks: 0,
    recoveryAttempts: 0,
    staleGenerationSubmissions: 0,
    diagnosticListeners: 0,
    deviceListeners: 0,
    shaderModulesCreated: 1,
    pipelinesCreated: 1,
    resources: {
      created: 0,
      live: 0,
      liveBytes: 0,
      peakLiveBytes: 0,
      byCategory: {
        buffer: { ...empty },
        texture: { ...empty },
        'texture-view': { ...empty },
        sampler: { ...empty },
        'bind-group': { ...empty },
        'bind-group-layout': { ...empty },
        'pipeline-layout': { ...empty },
        'render-pipeline': { ...empty },
        'shader-module': { ...empty },
      },
    },
  };
}

function frame(scenario: P1Scenario, elapsedMs: number, index: number): P1FrameObservation {
  const population = P1_CONFIGURATION.scenarios[scenario].population;
  const expectedVisible = P1_CONFIGURATION.scenarios[scenario].expectedVisible;
  return {
    timestampMs: 1_000 + elapsedMs,
    elapsedMs,
    generation: 1,
    sceneRevision: index,
    cameraRevision: index,
    submissionCount: 1,
    packetCount: 1,
    visibleCount: expectedVisible,
    drawInstanceCount: expectedVisible,
    writes: [],
    pipelineCreations: 0,
    shaderCreations: 0,
    visible: true,
    errors: [],
    cpu:
      index === 0
        ? {
            geometryBuilds: population,
            recordWrites: {
              transforms: population,
              geometry: population,
              styles: population,
              order: population,
              frame: 1,
            },
          }
        : zeroP1CpuStatistics(),
  };
}

function capture(
  scenario: P1Scenario,
  profile: P1ProfileName,
  intervalMs = 10,
): P1FunctionalCapture {
  const elapsed =
    profile === 'reference'
      ? [
          0,
          4_990,
          5_000,
          5_000 + intervalMs,
          5_000 + intervalMs * 2,
          5_000 + intervalMs * 3,
          5_000 + intervalMs * 4,
          15_000,
        ]
      : [0, 16, 32, 48, 64, 80, 96, 112];
  const frames = elapsed.map((value, index) => frame(scenario, value, index));
  const cpuTotals = frames.reduce(
    (total, item) => ({
      geometryBuilds: total.geometryBuilds + item.cpu.geometryBuilds,
      recordWrites: {
        transforms: total.recordWrites.transforms + item.cpu.recordWrites.transforms,
        geometry: total.recordWrites.geometry + item.cpu.recordWrites.geometry,
        styles: total.recordWrites.styles + item.cpu.recordWrites.styles,
        order: total.recordWrites.order + item.cpu.recordWrites.order,
        frame: total.recordWrites.frame + item.cpu.recordWrites.frame,
      },
    }),
    zeroP1CpuStatistics(),
  );
  return {
    profile: P1_PROFILES[profile],
    scenario,
    configuration: p1RunConfiguration(profile),
    frames,
    cpuTotals,
    window: {
      scenario,
      startMs: profile === 'reference' ? 5_000 : frames[3]!.elapsedMs,
      endMs: profile === 'reference' ? 15_000 : frames.at(-1)!.elapsedMs + 1,
    },
    metrics: summarizeP1RunFrames(frames, scenario, profile),
    capability: {
      supported: true,
      capabilities: {
        backend: 'webgpu',
        adapter: { vendor: 'test-vendor', architecture: 'test-architecture' },
        selectedFeatures: [],
        limits: { maxTextureDimension2D: 8192 },
        sampleCount: 4,
      },
    },
    diagnostics: [],
    errors: [],
    visibility: [],
    initialWrites: [],
    maximumPendingCallbacks: 1,
    pendingCallbacksAfterDispose: 0,
    disposed: disposedStatistics(),
    environment: {
      timeOrigin: 1_000,
      observedTimerIncrementsMs: [0.01],
      windowBounds: {
        screenX: 0,
        screenY: 0,
        outerWidth: 1280,
        outerHeight: 720,
        innerWidth: 1280,
        innerHeight: 720,
      },
      instrumentation: ['synthetic raw callbacks'],
      userAgent: 'synthetic-p1-aggregate-test',
      cssSize: { width: 1280, height: 720 },
      physicalSize: { width: 1280, height: 720 },
      devicePixelRatio: 1,
      visibilityState: 'visible',
    },
    unavailable: {
      A09: 'No accepted complete simultaneous CPU/GPU peak method.',
      A10: 'No verified pointer/content/physical-presentation and clock linkage.',
    },
  };
}

function writeJson(file: string, value: unknown): void {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function initializeRoot(root: string, profile: P1ProfileName, runSource = source()): void {
  const marker = { schema: 'p1-observed-run-source/v1', profile, source: runSource };
  writeJson(path.join(root, 'source-start.json'), marker);
  writeJson(path.join(root, 'source-end.json'), marker);
}

function writeRecord(
  root: string,
  scenario: P1Scenario,
  browser: (typeof browsers)[number],
  profile: P1ProfileName,
  repetition: number,
  intervalMs = 10,
) {
  const record = createP1FunctionalRecord(
    capture(scenario, profile, intervalMs),
    source(),
    { name: browser, version: browser === 'chrome' ? '140.0.1' : '140.0.2' },
    [],
    repetition,
  );
  const directory = path.join(root, `${browser}-${scenario.replace('/', '-')}-${repetition}`);
  mkdirSync(directory);
  writeJson(path.join(directory, 'record.json'), record);
  writeJson(path.join(directory, 'source-end.json'), source());
  writeJson(path.join(directory, 'validation.json'), { observed: [], integrity: [] });
  return { directory, record };
}

function completeRun(root: string, profile: P1ProfileName): void {
  initializeRoot(root, profile);
  const repetitions = profile === 'reference' ? 5 : 1;
  for (const scenario of P1_SCENARIOS)
    for (const browser of browsers)
      for (let repetition = 1; repetition <= repetitions; repetition += 1) {
        const base = scenario === 'p1-pan-zoom-10k/v1' ? 20 : 10;
        writeRecord(root, scenario, browser, profile, repetition, base + repetition);
      }
}

function replaceRecord(directory: string, mutate: (record: Record<string, unknown>) => void): void {
  const file = path.join(directory, 'record.json');
  const record = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
  mutate(record);
  writeJson(file, record);
}

describe('P1 runner aggregate', () => {
  it('recomputes five reference repetitions and takes the maximum raw per-run p95', () => {
    const root = temporaryRoot();
    completeRun(root, 'reference');
    const result = aggregateP1Records(root);

    expect(result.findings).toEqual([]);
    expect(result.criteria).toEqual({ A05: 'CANDIDATE', A08: 'CANDIDATE' });
    expect(result.groups).toHaveLength(8);
    expect(
      result.groups.find(
        (group) => group.scenario === 'p1-pan-zoom-1k/v1' && group.browser === 'chrome',
      ),
    ).toMatchObject({
      repetitions: [1, 2, 3, 4, 5],
      maxP95Ms: 15,
      ceilingMs: 16.7,
      criteria: { A05: 'CANDIDATE', A08: 'CANDIDATE' },
    });
    expect(
      result.groups.find((group) => group.scenario === 'p1-single-transform-10k/v1'),
    ).toMatchObject({ maxP95Ms: 15, ceilingMs: null, criteria: { A08: 'NOT_APPLICABLE' } });
  });

  it('preserves an observed numeric threshold failure as explicit FAIL', () => {
    const root = temporaryRoot();
    completeRun(root, 'reference');
    const target = path.join(root, 'chrome-p1-pan-zoom-1k-v1-5');
    const failed = createP1FunctionalRecord(
      capture('p1-pan-zoom-1k/v1', 'reference', 17),
      source(),
      { name: 'chrome', version: '140.0.1' },
      [],
      5,
    );
    writeJson(path.join(target, 'record.json'), failed);

    const result = aggregateP1Records(root);
    const group = result.groups.find(
      (value) => value.scenario === 'p1-pan-zoom-1k/v1' && value.browser === 'chrome',
    )!;
    expect(group.maxP95Ms).toBe(17);
    expect(group.criteria.A08).toBe('FAIL');
    expect(result.criteria.A05).toBe('CANDIDATE');
    expect(result.criteria.A08).toBe('FAIL');
    expect(group.findings).toContain('Raw maximum p95 17 ms exceeds the 16.7 ms A08 ceiling.');
  });

  it('rejects missing and duplicate top-level repetition identities', () => {
    const root = temporaryRoot();
    completeRun(root, 'reference');
    rmSync(path.join(root, 'edge-p1-cull-10k-v1-5'), { recursive: true });
    replaceRecord(path.join(root, 'edge-p1-cull-10k-v1-4'), (record) => {
      record.repetition = 3;
    });

    const result = aggregateP1Records(root);
    expect(result.findings).toEqual(
      expect.arrayContaining([
        expect.stringContaining('Expected unique repetitions 1, 2, 3, 4, 5'),
      ]),
    );
    expect(result.criteria.A05).toBe('UNVERIFIED');
  });

  it('rejects incompatible source, configuration, browser and device metadata', () => {
    const root = temporaryRoot();
    completeRun(root, 'reference');
    replaceRecord(path.join(root, 'chrome-p1-pan-zoom-1k-v1-2'), (record) => {
      record.configurationSha256 = 'tampered';
    });
    replaceRecord(path.join(root, 'chrome-p1-pan-zoom-1k-v1-3'), (record) => {
      record.source = source('b');
    });
    replaceRecord(path.join(root, 'chrome-p1-pan-zoom-1k-v1-4'), (record) => {
      const environment = record.environment as Record<string, unknown>;
      environment.browser = { name: 'chrome', version: 'different' };
      const captured = record.capture as Record<string, unknown>;
      const capability = captured.capability as Record<string, unknown>;
      const capabilities = capability.capabilities as Record<string, unknown>;
      capabilities.adapter = { vendor: 'different-adapter' };
    });

    const result = aggregateP1Records(root);
    expect(result.findings).toEqual(
      expect.arrayContaining([
        expect.stringContaining('source differs from run start'),
        expect.stringContaining('configuration hash'),
        expect.stringContaining('browser/device environment is incompatible'),
        expect.stringContaining('browser versions'),
      ]),
    );
    expect(result.criteria).toEqual({ A05: 'UNVERIFIED', A08: 'UNVERIFIED' });
  });

  it('recomputes raw metrics and rejects stored claims', () => {
    const root = temporaryRoot();
    completeRun(root, 'reference');
    const target = path.join(root, 'edge-p1-pan-zoom-10k-v1-1');
    replaceRecord(target, (record) => {
      record.disposition = 'REFERENCE_CANDIDATE';
      record.acceptance = { P1: 'PASS', A09: 'PASS', A10: 'PASS' };
      const captureValue = record.capture as Record<string, unknown>;
      const metrics = captureValue.metrics as Record<string, unknown>;
      metrics.summary = { count: 1, min: 0, median: 0, p95: 0, p99: 0, max: 0 };
    });

    const result = aggregateP1Records(root);
    expect(result.findings).toEqual(
      expect.arrayContaining([
        expect.stringContaining('Recorded metrics disagree with raw callbacks'),
        expect.stringContaining('unsupported acceptance'),
      ]),
    );
    expect(result.criteria.A05).toBe('UNVERIFIED');
  });

  it('suppresses every candidate for missing markers and extra malformed raw groups', () => {
    const root = temporaryRoot();
    completeRun(root, 'reference');
    rmSync(path.join(root, 'source-start.json'));
    rmSync(path.join(root, 'source-end.json'));
    const extra = path.join(root, 'extra-unreadable-group');
    mkdirSync(extra);
    writeFileSync(path.join(extra, 'record.json'), '{invalid');

    const result = aggregateP1Records(root);
    expect(result.findings).toEqual(
      expect.arrayContaining([
        'source-start.json is missing.',
        'source-end.json is missing.',
        expect.stringContaining('could not be read'),
      ]),
    );
    expect(result.criteria).toEqual({ A05: 'UNVERIFIED', A08: 'UNVERIFIED' });
    expect(
      result.groups.every(
        (group) => group.criteria.A05 !== 'CANDIDATE' && group.criteria.A08 !== 'CANDIDATE',
      ),
    ).toBe(true);
  });

  it('retains a partial matching raw record as an invalid repetition instead of throwing', () => {
    const root = temporaryRoot();
    completeRun(root, 'reference');
    const directory = path.join(root, 'partial-record');
    mkdirSync(directory);
    writeJson(path.join(directory, 'record.json'), {
      repetition: 6,
      capture: { scenario: 'p1-pan-zoom-1k/v1' },
      environment: { browser: { name: 'chrome' } },
    });
    writeJson(path.join(directory, 'source-end.json'), source());

    const result = aggregateP1Records(root);
    expect(result.findings).toEqual(
      expect.arrayContaining([
        expect.stringContaining('could not be validated from raw evidence'),
        expect.stringContaining('Expected unique repetitions 1, 2, 3, 4, 5'),
      ]),
    );
    expect(result.criteria.A05).toBe('UNVERIFIED');
  });

  it('rejects empty run provenance and suppresses every candidate', () => {
    const root = temporaryRoot();
    completeRun(root, 'reference');
    writeJson(path.join(root, 'source-start.json'), { profile: 'reference', source: {} });
    writeJson(path.join(root, 'source-end.json'), { profile: 'reference', source: {} });

    const result = aggregateP1Records(root);
    expect(result.findings).toEqual(
      expect.arrayContaining([
        'source-start.json source is missing or invalid.',
        'source-end.json source is missing or invalid.',
      ]),
    );
    expect(result.criteria).toEqual({ A05: 'UNVERIFIED', A08: 'UNVERIFIED' });
    expect(
      result.groups.every(
        (group) => group.criteria.A05 !== 'CANDIDATE' && group.criteria.A08 !== 'CANDIDATE',
      ),
    ).toBe(true);
  });

  it('keeps functional aggregates free of A05/A08 threshold claims', () => {
    const root = temporaryRoot();
    process.env.P1_RUNNER_COMMAND = JSON.stringify([
      'pnpm',
      'benchmark:p1',
      '--profile',
      'functional',
    ]);
    delete process.env.P1_RUNNER_ENVIRONMENT;
    completeRun(root, 'functional');

    const result = aggregateP1Records(root);
    expect(result.findings).toEqual([]);
    expect(result.criteria).toEqual({ A05: 'UNVERIFIED', A08: 'UNVERIFIED' });
    expect(result.groups.every((group) => group.maxP95Ms === null)).toBe(true);
    expect(result.groups.every((group) => group.criteria.A08 === 'UNVERIFIED')).toBe(true);
  });

  it('writes durable machine-readable findings before failing malformed evidence', () => {
    const root = temporaryRoot();
    initializeRoot(root, 'reference');
    const directory = path.join(root, 'broken');
    mkdirSync(directory);
    writeFileSync(path.join(directory, 'record.json'), '{invalid');

    expect(() => writeP1Aggregate(root)).toThrow();
    const aggregate = JSON.parse(readFileSync(path.join(root, 'aggregate.json'), 'utf8')) as {
      acceptance: Record<string, string>;
      findings: string[];
    };
    expect(aggregate.acceptance).toEqual({
      P1: 'UNVERIFIED',
      A09: 'UNVERIFIED',
      A10: 'UNVERIFIED',
    });
    expect(aggregate.findings).toEqual(
      expect.arrayContaining([
        expect.stringContaining('could not be read'),
        expect.stringContaining('observed none'),
      ]),
    );
    expect(p1Hash(aggregate.acceptance)).toBe(
      p1Hash({ P1: 'UNVERIFIED', A09: 'UNVERIFIED', A10: 'UNVERIFIED' }),
    );
  });
});
