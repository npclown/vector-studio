import { describe, expect, it } from 'vitest';
import { P1_CONFIGURATION } from '../../apps/playground/src/p1-workloads.js';

import {
  zeroP1CpuStatistics,
  type P1FrameObservation,
} from '../../apps/playground/src/p1-run-metrics.js';
import {
  P1_PROFILES,
  P1_RUNNER_VERSION,
  p1LastCallback,
  p1MeasurementWindow,
  p1RunConfiguration,
  summarizeP1RunFrames,
} from '../../apps/playground/src/p1-run-profiles.js';

const scenario = 'p1-pan-zoom-1k/v1' as const;
const ORIGIN_MS = 50_000;

function frame(elapsedMs: number, overrides: Partial<P1FrameObservation> = {}): P1FrameObservation {
  return {
    timestampMs: ORIGIN_MS + elapsedMs,
    elapsedMs,
    generation: 1,
    sceneRevision: 0,
    cameraRevision: 0,
    submissionCount: 1,
    packetCount: 1,
    visibleCount: 1_000,
    drawInstanceCount: 1_000,
    writes: [],
    pipelineCreations: 0,
    shaderCreations: 0,
    visible: true,
    errors: [],
    cpu: zeroP1CpuStatistics(),
    ...overrides,
  };
}

function referenceFrames(): P1FrameObservation[] {
  return [
    frame(0, {
      pipelineCreations: 1,
      shaderCreations: 1,
      cpu: {
        geometryBuilds: 1_000,
        recordWrites: { transforms: 0, geometry: 1_000, styles: 0, order: 0, frame: 0 },
      },
    }),
    frame(4_999),
    frame(5_000),
    frame(5_016),
    frame(14_999),
    frame(15_000),
  ];
}

describe('P1 run profiles', () => {
  it('publishes frozen functional and reference definitions with a versioned configuration', () => {
    expect(P1_PROFILES).toEqual({
      functional: { name: 'functional', warmupFrames: 3, measuredFrames: 5, repetitions: 1 },
      reference: { name: 'reference', warmupMs: 5_000, measuredMs: 10_000, repetitions: 5 },
    });
    expect(Object.isFrozen(P1_PROFILES)).toBe(true);
    expect(Object.isFrozen(P1_PROFILES.functional)).toBe(true);
    expect(Object.isFrozen(P1_PROFILES.reference)).toBe(true);
    expect(p1RunConfiguration('reference')).toMatchObject({
      version: P1_RUNNER_VERSION,
      workload: P1_CONFIGURATION,
      profile: P1_PROFILES.reference,
    });
  });

  it('uses the third functional callback through the final callback plus one and fixed reference bounds', () => {
    const functional = Array.from({ length: 8 }, (_, index) => frame(index * 16));
    expect(p1MeasurementWindow(scenario, 'functional', functional)).toEqual({
      scenario,
      startMs: 48,
      endMs: 113,
    });
    expect(p1MeasurementWindow(scenario, 'reference', functional)).toEqual({
      scenario,
      startMs: 5_000,
      endMs: 15_000,
    });
    expect(p1LastCallback('functional', 6, 0)).toBe(false);
    expect(p1LastCallback('functional', 7, 0)).toBe(true);
    expect(p1LastCallback('reference', 0, 14_999)).toBe(false);
    expect(p1LastCallback('reference', 0, 15_000)).toBe(true);
  });

  it('keeps functional observations functional and requires exactly eight callbacks', () => {
    const valid = Array.from({ length: 8 }, (_, index) =>
      frame(
        index * 16,
        index === 0
          ? { cpu: { geometryBuilds: 1, recordWrites: zeroP1CpuStatistics().recordWrites } }
          : {},
      ),
    );
    expect(summarizeP1RunFrames(valid, scenario, 'functional')).toMatchObject({
      disposition: 'FUNCTIONAL_ONLY',
      findings: [],
    });

    const invalid = summarizeP1RunFrames(valid.slice(0, 7), scenario, 'functional');
    expect(invalid.disposition).toBe('FUNCTIONAL_ONLY');
    expect(invalid.findings).toContain('functional run must contain exactly 8 callbacks');
  });

  it('retains the exact 15000 ms reference boundary and permits a long measured interval', () => {
    const result = summarizeP1RunFrames(referenceFrames(), scenario, 'reference');

    expect(result.intervals).toEqual([16, 9_983]);
    expect(result.summary?.max).toBe(9_983);
    expect(result.findings).toEqual([]);
    expect(result.disposition).toBe('REFERENCE_CANDIDATE');
  });

  it('does not filter failed callbacks out of a reference candidate', () => {
    const frames = referenceFrames();
    frames[3] = frame(5_016, { submissionCount: 0, errors: ['submission failed'] });
    const result = summarizeP1RunFrames(frames, scenario, 'reference');

    expect(result.intervals).toEqual([16, 9_983]);
    expect(result.findings).toEqual(
      expect.arrayContaining([
        expect.stringContaining('0 submissions'),
        expect.stringContaining('unexpected errors'),
      ]),
    );
    expect(result.disposition).toBe('FUNCTIONAL_ONLY');
  });

  it('rejects invalid CPU counts and a disconnected zero warm-up observer', () => {
    const invalid = referenceFrames();
    invalid[1] = frame(4_999, {
      cpu: { geometryBuilds: -1, recordWrites: { ...zeroP1CpuStatistics().recordWrites } },
    });
    const invalidResult = summarizeP1RunFrames(invalid, scenario, 'reference');
    expect(invalidResult.findings).toContain('frame 1 has an invalid CPU geometryBuilds count');

    const zeroObserver = referenceFrames().map((observed) => ({
      ...observed,
      cpu: zeroP1CpuStatistics(),
    }));
    const zeroResult = summarizeP1RunFrames(zeroObserver, scenario, 'reference');
    expect(zeroResult.findings).toContain('warm-up geometry builds 0 are below required 1000');
    expect(zeroResult.disposition).toBe('FUNCTIONAL_ONLY');
  });

  it('requires only the final reference sample to reach the endpoint and validates warm-up and boundary callbacks', () => {
    const earlyBoundary = referenceFrames();
    earlyBoundary[3] = frame(15_000);
    const result = summarizeP1RunFrames(earlyBoundary, scenario, 'reference');
    expect(result.findings).toEqual(
      expect.arrayContaining([
        expect.stringContaining('before the final sample'),
        expect.stringContaining('elapsed time is not strictly monotonic'),
      ]),
    );

    const boundaryFailure = referenceFrames();
    boundaryFailure[5] = frame(15_000, { packetCount: 0, visible: false, errors: ['lost'] });
    const failed = summarizeP1RunFrames(boundaryFailure, scenario, 'reference');
    expect(failed.findings).toEqual(
      expect.arrayContaining([
        expect.stringContaining('frame 5 has 0 packets'),
        expect.stringContaining('frame 5 was captured while hidden'),
        expect.stringContaining('frame 5 contains unexpected errors'),
      ]),
    );
  });

  it('requires functional warm-up CPU observation and validates every functional callback', () => {
    const frames = Array.from({ length: 8 }, (_, index) => frame(index * 16));
    frames[1] = frame(16, {
      sceneRevision: null,
      packetCount: 0,
      visible: false,
      errors: ['lost'],
    });
    const result = summarizeP1RunFrames(frames, scenario, 'functional');

    expect(result.findings).toEqual(
      expect.arrayContaining([
        'warm-up geometry builds 0 are below required 1',
        'frame 1 is missing a valid scene revision',
        'frame 1 has 0 packets instead of one',
        'frame 1 was captured while hidden',
        'frame 1 contains unexpected errors',
      ]),
    );
  });
});
