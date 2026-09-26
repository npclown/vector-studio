import { describe, expect, it } from 'vitest';

import {
  summarizeP1Frames,
  type P1FrameObservation,
  type P1WriteObservation,
} from '../../apps/playground/src/p1-run-metrics.js';

const ORIGIN_MS = 100_000;

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
    ...overrides,
  };
}

function write(overrides: Partial<P1WriteObservation> = {}): P1WriteObservation {
  return {
    resource: 'frame',
    offset: 0,
    bytes: 256,
    nativeBufferOffset: 0,
    ...overrides,
  };
}

const REFERENCE_WINDOW = {
  scenario: 'p1-pan-zoom-1k/v1' as const,
  startMs: 5_000,
  endMs: 15_000,
};

describe('summarizeP1Frames', () => {
  it('uses both half-open reference-window endpoints without bridging outside callbacks', () => {
    const result = summarizeP1Frames(
      [frame(4_999), frame(5_000), frame(5_001), frame(14_999), frame(15_000)],
      REFERENCE_WINDOW,
    );

    expect(result.intervals).toEqual([1, 9_998]);
    expect(result.summary).toEqual({
      count: 2,
      min: 1,
      median: 1,
      p95: 9_998,
      p99: 9_998,
      max: 9_998,
    });
    expect(result.findings).toEqual([]);
    expect(result.disposition).toBe('FUNCTIONAL_ONLY');
  });

  it('calculates nearest-rank quantiles independently and does not mutate inputs', () => {
    let elapsedMs = 5_000;
    const frames = [frame(elapsedMs)];
    for (let interval = 1; interval <= 100; interval += 1) {
      elapsedMs += interval;
      frames.push(frame(elapsedMs));
    }
    const original = structuredClone(frames);

    const result = summarizeP1Frames(frames, REFERENCE_WINDOW);

    expect(result.summary).toEqual({
      count: 100,
      min: 1,
      median: 50,
      p95: 95,
      p99: 99,
      max: 100,
    });
    expect(frames).toEqual(original);
  });

  it('retains long intervals on both sides of a failed callback', () => {
    const result = summarizeP1Frames(
      [
        frame(5_000),
        frame(5_016, { submissionCount: 0, errors: ['submission failed'] }),
        frame(7_016),
      ],
      REFERENCE_WINDOW,
    );

    expect(result.intervals).toEqual([16, 2_000]);
    expect(result.summary?.max).toBe(2_000);
    expect(result.findings).toEqual(
      expect.arrayContaining([
        expect.stringContaining('0 submissions'),
        expect.stringContaining('unexpected errors'),
      ]),
    );
  });

  it('reports an empty interval window as unavailable instead of zero', () => {
    const result = summarizeP1Frames([frame(5_000)], REFERENCE_WINDOW);

    expect(result.intervals).toEqual([]);
    expect(result.summary).toBeNull();
    expect(result.findings).toContain('measurement window contains no callback intervals');
  });

  it.each([
    ['generation zero', { generation: 0 }, 'invalid generation'],
    ['generation change', { generation: 2 }, 'changes the current generation'],
    ['missing scene revision', { sceneRevision: null }, 'scene revision'],
    ['missing camera revision', { cameraRevision: null }, 'camera revision'],
    ['submission count', { submissionCount: 2 }, '2 submissions'],
    ['packet count', { packetCount: 0 }, '0 packets'],
    ['visible count', { visibleCount: 999 }, '999 visible'],
    ['native instance count', { drawInstanceCount: 999 }, 'draws 999'],
    ['hidden document', { visible: false }, 'document was hidden'],
    ['diagnostic errors', { errors: ['validation'] }, 'unexpected errors'],
    ['warmed pipeline creation', { pipelineCreations: 1 }, 'warmed pipelines'],
    ['warmed shader creation', { shaderCreations: 1 }, 'warmed shaders'],
  ] as const)('rejects %s', (_name, mutation, finding) => {
    const first = frame(5_000);
    const second = frame(5_016, mutation);
    const result = summarizeP1Frames([first, second], REFERENCE_WINDOW);

    expect(result.findings.some((message) => message.includes(finding))).toBe(true);
  });

  it('rejects non-finite, non-monotonic and timestamp/elapsed-inconsistent observations', () => {
    const nonFinite = summarizeP1Frames(
      [frame(5_000), frame(5_016, { timestampMs: Number.NaN })],
      REFERENCE_WINDOW,
    );
    expect(nonFinite.intervals).toEqual([]);
    expect(nonFinite.findings).toEqual(
      expect.arrayContaining([
        expect.stringContaining('timestamp is not finite'),
        'measurement window contains no callback intervals',
      ]),
    );

    const nonMonotonic = summarizeP1Frames([frame(5_000), frame(5_000)], REFERENCE_WINDOW);
    expect(nonMonotonic.intervals).toEqual([0]);
    expect(nonMonotonic.findings).toEqual(
      expect.arrayContaining([
        expect.stringContaining('timestamp is not strictly monotonic'),
        expect.stringContaining('elapsed time is not strictly monotonic'),
      ]),
    );

    const inconsistent = summarizeP1Frames(
      [frame(5_000), frame(5_016, { timestampMs: ORIGIN_MS + 5_017 })],
      REFERENCE_WINDOW,
    );
    expect(inconsistent.intervals).toEqual([17]);
    expect(inconsistent.findings).toContain('frame 1 timestamp and elapsed-time deltas disagree');
  });

  it('allows only camera-frame and transform rebase writes for warmed S1/S2 callbacks', () => {
    const allowed = summarizeP1Frames(
      [
        frame(5_000, {
          writes: [write(), write({ resource: 'transforms', bytes: 32, nativeBufferOffset: 256 })],
        }),
        frame(5_016),
      ],
      REFERENCE_WINDOW,
    );
    expect(allowed.findings).toEqual([]);

    for (const resource of ['geometry', 'styles', 'order', 'unmapped'] as const) {
      const rejected = summarizeP1Frames(
        [frame(5_000, { writes: [write({ resource })] }), frame(5_016)],
        REFERENCE_WINDOW,
      );
      expect(rejected.findings.some((message) => message.includes(resource))).toBe(true);
    }
  });

  it('requires no warmed S3 writes', () => {
    const options = { ...REFERENCE_WINDOW, scenario: 'p1-cull-10k/v1' as const };
    const common = { visibleCount: 1_032, drawInstanceCount: 1_032 };
    const result = summarizeP1Frames(
      [frame(5_000, { ...common, writes: [write()] }), frame(5_016, common)],
      options,
    );

    expect(result.findings).toContain('frame 0 has an unexpected warmed write');
  });

  it('allows only the optional aligned slot-zero 32-byte transform write for warmed S4', () => {
    const options = { ...REFERENCE_WINDOW, scenario: 'p1-single-transform-10k/v1' as const };
    const common = { visibleCount: 1_032, drawInstanceCount: 1_032 };
    const accepted = summarizeP1Frames(
      [
        frame(5_000, {
          ...common,
          writes: [
            write({ resource: 'transforms', offset: 0, bytes: 32, nativeBufferOffset: 256 }),
          ],
        }),
        frame(5_016, common),
      ],
      options,
    );
    expect(accepted.findings).toEqual([]);

    const rejected = summarizeP1Frames(
      [
        frame(5_000, {
          ...common,
          writes: [
            write({ resource: 'transforms', offset: 32, bytes: 64, nativeBufferOffset: 2 }),
            write({ resource: 'geometry' }),
          ],
        }),
        frame(5_016, common),
      ],
      options,
    );
    expect(rejected.findings).toEqual(
      expect.arrayContaining([
        expect.stringContaining('not 4-byte aligned'),
        expect.stringContaining('more than one target transform write'),
        expect.stringContaining('non-target S4 write'),
      ]),
    );
  });

  it('rejects malformed native write ranges', () => {
    const result = summarizeP1Frames(
      [
        frame(5_000, {
          writes: [write({ offset: -1, bytes: 0, nativeBufferOffset: -1 })],
        }),
        frame(5_016),
      ],
      REFERENCE_WINDOW,
    );

    expect(result.findings).toEqual(
      expect.arrayContaining([
        expect.stringContaining('invalid resource offset'),
        expect.stringContaining('invalid byte length'),
        expect.stringContaining('invalid native buffer offset'),
      ]),
    );
  });
});
