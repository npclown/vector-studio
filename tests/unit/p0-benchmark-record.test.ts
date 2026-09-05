import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  P0_BENCHMARK_SCHEMA,
  P0_RUNNER_ID,
  benchmarkArtifactBaseName,
  canonicalJson,
  configurationHash,
  renderP0BenchmarkMarkdown,
  validateP0BenchmarkRecord,
  writeP0BenchmarkArtifacts,
  type JsonValue,
  type P0BenchmarkRecord,
} from '../support/p0-benchmark-record.js';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function environment(): P0BenchmarkRecord['environment'] {
  return {
    operatingSystem: 'win32 10.0 test',
    cpu: 'test cpu',
    logicalCores: 8,
    installedMemoryBytes: 16_000_000_000,
    gpu: { vendor: 'test', architecture: 'test' },
    browser: { channel: 'chrome', version: '1.2.3' },
    browserLaunchFlags: ['--enable-unsafe-webgpu'],
    displayRefreshRate: { availability: 'available', value: 60, unit: 'Hz' },
    selectedFeatures: [],
    sampleCount: 4,
    viewport: { css: [1280, 720], physical: [1280, 720], devicePixelRatio: 1 },
    power: { source: 'AC', mode: 'balanced' },
  };
}

function record(runId = 'run-a'): P0BenchmarkRecord {
  const configuration: JsonValue = {
    measuredDurationMs: 10_000,
    repetitions: 5,
    scenario: 'steady-foundation',
    seed: 0,
    viewport: [1280, 720],
    warmupDurationMs: 3000,
  };
  return {
    schema: P0_BENCHMARK_SCHEMA,
    status: 'Exploratory',
    identity: {
      revision: '0123456789abcdef0123456789abcdef01234567',
      sourceState: 'clean',
      runId,
      timestampUtc: '2026-09-06T01:02:03.456Z',
      localTimezone: 'Asia/Seoul',
    },
    runner: {
      id: P0_RUNNER_ID,
      command: 'pnpm benchmark:p0 -- --profile smoke',
      buildMode: 'production',
    },
    environment: environment(),
    scenario: {
      id: 'p0/steady-foundation',
      version: 1,
      seed: 0,
      profile: 'smoke',
      configuration,
      configurationHash: configurationHash(configuration),
    },
    repetitions: [
      {
        index: 1,
        startedAtUtc: '2026-09-06T01:02:04.000Z',
        endedAtUtc: '2026-09-06T01:02:05.000Z',
        window: { clock: 'performance.now', startMs: 100, endMs: 1100 },
        sampleCounts: { frameIntervalMs: 1 },
        samples: { frameIntervalMs: [16.25] },
        metrics: {
          frameIntervalP95: {
            availability: 'available',
            value: 16.25,
            unit: 'ms',
            clock: 'performance.now',
            startEvent: 'previous-animation-frame',
            endEvent: 'animation-frame',
            observation: 'requestAnimationFrame callback interval',
          },
          observedPresentation: {
            availability: 'unavailable',
            reason: 'browser-webgpu-no-presentation-timestamp',
            unit: 'ms',
            clock: 'unavailable',
            startEvent: 'initialize-call',
            endEvent: 'physical-display-presentation',
            observation: 'unavailable',
          },
        },
        diagnostics: { expected: [], unexpected: [] },
      },
    ],
  };
}

describe('P0 benchmark record contract', () => {
  it('canonicalizes recursively sorted object keys and hashes the full configuration', () => {
    const first: JsonValue = { z: [3, { b: true, a: 'value' }], a: 1 };
    const second: JsonValue = { a: 1, z: [3, { a: 'value', b: true }] };

    expect(canonicalJson(first)).toBe('{"a":1,"z":[3,{"a":"value","b":true}]}');
    expect(configurationHash(first)).toBe(configurationHash(second));
    expect(configurationHash(first)).toMatch(/^[0-9a-f]{64}$/u);
    expect(() => canonicalJson({ invalid: Number.NaN })).toThrow(TypeError);
  });

  it('rejects false-zero, invalid metadata, dirty provenance, and hash mismatch', () => {
    const valid = record();
    expect(validateP0BenchmarkRecord(valid)).toEqual([]);

    const invalid = structuredClone(valid);
    Object.assign(invalid.identity, { sourceState: 'dirty', sourceDelta: '' });
    Object.assign(invalid.scenario, { configurationHash: 'wrong' });
    Object.assign(invalid.repetitions[0]?.samples ?? {}, { frameIntervalMs: [Number.NaN] });
    Object.assign(invalid.repetitions[0]?.sampleCounts ?? {}, { frameIntervalMs: 0 });
    Object.assign(invalid.repetitions[0]?.metrics.observedPresentation ?? {}, { reason: '' });
    delete (invalid.environment as Record<string, unknown>).browserLaunchFlags;

    expect(validateP0BenchmarkRecord(invalid)).toEqual(
      expect.arrayContaining([
        'dirty source requires identity.sourceDelta.',
        'environment.browserLaunchFlags is required.',
        'scenario.configurationHash does not match canonical configuration.',
        'repetitions[0].samples.frameIntervalMs contains an invalid duration.',
        'repetitions[0].sampleCounts must contain a positive count.',
        'repetitions[0].metrics.observedPresentation.reason must be non-empty when unavailable.',
      ]),
    );
  });

  it('renders the same metric facts into Markdown without accepting itself', () => {
    const markdown = renderP0BenchmarkMarkdown(record());
    expect(markdown).toContain('Status: Exploratory');
    expect(markdown).toContain('| frameIntervalP95 | 16.25 ms |');
    expect(markdown).toContain('UNAVAILABLE: browser-webgpu-no-presentation-timestamp');
    expect(markdown).toContain('not accepted automatically');
  });

  it('writes collision-safe JSON and Markdown pairs and refuses replacement', () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'vector-studio-p0-record-'));
    temporaryDirectories.push(directory);
    const first = record('run-a');
    const firstPaths = writeP0BenchmarkArtifacts(first, directory, 'Chrome', 'Reference PC');

    expect(JSON.parse(readFileSync(firstPaths.json, 'utf8'))).toEqual(first);
    expect(readFileSync(firstPaths.markdown, 'utf8')).toBe(renderP0BenchmarkMarkdown(first));
    expect(() => writeP0BenchmarkArtifacts(first, directory, 'Chrome', 'Reference PC')).toThrow();
    expect(readdirSync(directory)).toHaveLength(2);

    const second = record('run-b');
    writeP0BenchmarkArtifacts(second, directory, 'Chrome', 'Reference PC');
    expect(readdirSync(directory)).toHaveLength(4);
    expect(benchmarkArtifactBaseName(first, 'Chrome', 'Reference PC')).not.toBe(
      benchmarkArtifactBaseName(second, 'Chrome', 'Reference PC'),
    );
  });
});
