import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { RendererStatistics } from '@vector-studio/contracts';
import { afterEach, describe, expect, it } from 'vitest';

import type { P1FunctionalCapture } from '../../apps/playground/src/p1-runner.js';
import {
  summarizeP1Frames,
  type P1FrameObservation,
} from '../../apps/playground/src/p1-run-metrics.js';
import { P1_CONFIGURATION } from '../../apps/playground/src/p1-workloads.js';
import { p1Source } from '../support/p1-evidence.js';
import {
  createP1FunctionalRecord,
  functionalFindings,
  writeP1FunctionalRecord,
} from '../support/p1-runner-record.js';

type P1Source = ReturnType<typeof p1Source>;

const temporaryDirectories: string[] = [];
const scenario = 'p1-pan-zoom-1k/v1' as const;

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function temporaryRoot(): string {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'vector-studio-p1-record-'));
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

function frame(index: number, overrides: Partial<P1FrameObservation> = {}): P1FrameObservation {
  const elapsedMs = index * 16;
  return {
    timestampMs: 1_000 + elapsedMs,
    elapsedMs,
    generation: 1,
    sceneRevision: 0,
    cameraRevision: index,
    submissionCount: 1,
    packetCount: 1,
    visibleCount: 1_000,
    drawInstanceCount: 1_000,
    writes: [],
    pipelineCreations: 0,
    shaderCreations: 0,
    visible: true,
    errors: [],
    ...overrides,
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

function capture(overrides: Partial<P1FunctionalCapture> = {}): P1FunctionalCapture {
  const frames = Array.from({ length: 8 }, (_, index) => frame(index));
  const window = { scenario, startMs: frames[3]!.elapsedMs, endMs: frames[7]!.elapsedMs + 1 };
  return {
    profile: { name: 'functional', warmupFrames: 3, measuredFrames: 5 },
    scenario,
    configuration: P1_CONFIGURATION,
    frames,
    window,
    metrics: summarizeP1Frames(frames, window),
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
      userAgent: 'synthetic-p1-record-test',
      cssSize: { width: 1280, height: 720 },
      physicalSize: { width: 1280, height: 720 },
      devicePixelRatio: 1,
      visibilityState: 'visible',
    },
    unavailable: {
      cpuGeometryRebuilds: 'Upload absence does not observe CPU geometry rebuild events.',
      A09: 'No accepted complete simultaneous CPU/GPU peak method.',
      A10: 'No verified pointer/content/physical-presentation and clock linkage.',
    },
    ...overrides,
  };
}

function record(value = capture()) {
  return createP1FunctionalRecord(value, source(), { name: 'chrome', version: '1.2.3' }, []);
}

describe('P1 functional runner record', () => {
  it('accepts a structurally complete functional-only capture', () => {
    const value = capture();
    const result = record(value);

    expect(functionalFindings(value)).toEqual([]);
    expect(result.disposition).toBe('FUNCTIONAL_PASS');
    expect(Object.values(result.acceptance)).toEqual([
      'UNVERIFIED',
      'UNVERIFIED',
      'UNVERIFIED',
      'UNVERIFIED',
      'UNVERIFIED',
    ]);
  });

  it('recomputes metrics from raw callbacks and rejects recorded-metric tampering', () => {
    const result = record();
    Object.assign(result.capture, {
      metrics: { ...result.capture.metrics, intervals: [999] },
    });

    expect(functionalFindings(result.capture)).toContain(
      'Recorded metrics disagree with raw callbacks.',
    );
    expect(() =>
      writeP1FunctionalRecord(path.join(temporaryRoot(), 'tampered'), result, source()),
    ).toThrow('Inconsistent functional evidence or acceptance claim.');
  });

  it('rejects source drift before creating evidence', () => {
    const root = temporaryRoot();
    const directory = path.join(root, 'source-drift');

    expect(() => writeP1FunctionalRecord(directory, record(), source('b'))).toThrow(
      'Source drift during functional capture.',
    );
    expect(() => readFileSync(path.join(directory, 'record.json'), 'utf8')).toThrow();
  });

  it('detects callback-count and functional-window mismatches', () => {
    const countMismatch = capture({ frames: capture().frames.slice(0, 7) });
    expect(functionalFindings(countMismatch)).toContain(
      'Expected 3 warmup + 5 observed callbacks and 4 intervals.',
    );

    const base = capture();
    const windowMismatch = capture({
      window: { ...base.window, startMs: base.window.startMs + 1 },
    });
    expect(functionalFindings(windowMismatch)).toContain(
      'Window differs from functional callback boundaries.',
    );
  });

  it('rejects any attempt to promote functional evidence to acceptance', () => {
    const result = record();
    Object.assign(result.acceptance, { A08: 'PASS' });

    expect(() =>
      writeP1FunctionalRecord(path.join(temporaryRoot(), 'promoted'), result, source()),
    ).toThrow('Inconsistent functional evidence or acceptance claim.');
  });

  it('preserves the first record when its exclusive case directory collides', () => {
    const directory = path.join(temporaryRoot(), 'collision');
    const result = record();
    writeP1FunctionalRecord(directory, result, source());
    const first = readFileSync(path.join(directory, 'record.json'), 'utf8');

    expect(() => writeP1FunctionalRecord(directory, result, source())).toThrow();
    expect(readFileSync(path.join(directory, 'record.json'), 'utf8')).toBe(first);
  });

  it('persists an honestly failed capture as FUNCTIONAL_FAIL', () => {
    const base = capture();
    const frames = base.frames.map((value, index) =>
      index === 4
        ? frame(index, { submissionCount: 0, errors: ['native submission failed'] })
        : value,
    );
    const failedCapture = capture({
      frames,
      metrics: summarizeP1Frames(frames, base.window),
    });
    const failedRecord = record(failedCapture);
    const directory = path.join(temporaryRoot(), 'failed-capture');

    expect(failedRecord.disposition).toBe('FUNCTIONAL_FAIL');
    expect(failedRecord.findings).toEqual(
      expect.arrayContaining([
        expect.stringContaining('0 submissions'),
        expect.stringContaining('unexpected errors'),
        'Renderer error observed.',
      ]),
    );
    writeP1FunctionalRecord(directory, failedRecord, source());
    const persisted = JSON.parse(readFileSync(path.join(directory, 'record.json'), 'utf8')) as {
      disposition: string;
      findings: string[];
    };
    expect(persisted.disposition).toBe('FUNCTIONAL_FAIL');
    expect(persisted.findings).toEqual(failedRecord.findings);
  });
});
