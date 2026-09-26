import type { P1Scenario } from './p1-workloads.js';

export type P1WriteObservation = Readonly<{
  resource: 'transforms' | 'geometry' | 'styles' | 'order' | 'frame' | 'unmapped';
  offset: number;
  bytes: number;
  nativeBufferOffset: number;
}>;

export type P1FrameObservation = Readonly<{
  timestampMs: number;
  elapsedMs: number;
  generation: number;
  sceneRevision: number | null;
  cameraRevision: number | null;
  submissionCount: number;
  packetCount: number;
  visibleCount: number | null;
  drawInstanceCount: number;
  writes: readonly P1WriteObservation[];
  pipelineCreations: number;
  shaderCreations: number;
  visible: boolean;
  errors: readonly string[];
}>;

export type P1IntervalSummary = Readonly<{
  count: number;
  min: number;
  median: number;
  p95: number;
  p99: number;
  max: number;
}>;

export type P1FrameSummary = Readonly<{
  intervals: readonly number[];
  summary: P1IntervalSummary | null;
  findings: readonly string[];
  disposition: 'FUNCTIONAL_ONLY';
}>;

const EXPECTED_VISIBLE: Readonly<Record<P1Scenario, number>> = Object.freeze({
  'p1-pan-zoom-1k/v1': 1_000,
  'p1-pan-zoom-10k/v1': 10_000,
  'p1-cull-10k/v1': 1_032,
  'p1-single-transform-10k/v1': 1_032,
});

function nearestRank(sorted: readonly number[], fraction: number): number {
  return sorted[Math.max(0, Math.ceil(fraction * sorted.length) - 1)]!;
}

function summarize(intervals: readonly number[]): P1IntervalSummary | null {
  if (intervals.length === 0) return null;
  const sorted = [...intervals].sort((left, right) => left - right);
  return Object.freeze({
    count: intervals.length,
    min: sorted[0]!,
    median: nearestRank(sorted, 0.5),
    p95: nearestRank(sorted, 0.95),
    p99: nearestRank(sorted, 0.99),
    max: sorted.at(-1)!,
  });
}

function isNonNegativeInteger(value: number): boolean {
  return Number.isInteger(value) && value >= 0;
}

function validateWriteShape(
  write: P1WriteObservation,
  frameIndex: number,
  writeIndex: number,
  findings: string[],
): void {
  const prefix = `frame ${frameIndex} write ${writeIndex}`;
  if (!isNonNegativeInteger(write.offset))
    findings.push(`${prefix} has an invalid resource offset`);
  if (!Number.isInteger(write.bytes) || write.bytes <= 0) {
    findings.push(`${prefix} has an invalid byte length`);
  }
  if (!isNonNegativeInteger(write.nativeBufferOffset)) {
    findings.push(`${prefix} has an invalid native buffer offset`);
  } else if (write.nativeBufferOffset % 4 !== 0) {
    findings.push(`${prefix} native buffer offset is not 4-byte aligned`);
  }
  if (write.resource === 'unmapped') findings.push(`${prefix} is not mapped to a packet resource`);
}

function validateWrites(
  scenario: P1Scenario,
  writes: readonly P1WriteObservation[],
  frameIndex: number,
  findings: string[],
): void {
  writes.forEach((write, writeIndex) =>
    validateWriteShape(write, frameIndex, writeIndex, findings),
  );

  if (scenario === 'p1-cull-10k/v1') {
    if (writes.length !== 0) findings.push(`frame ${frameIndex} has an unexpected warmed write`);
    return;
  }

  if (scenario === 'p1-single-transform-10k/v1') {
    if (writes.length > 1)
      findings.push(`frame ${frameIndex} has more than one target transform write`);
    for (const write of writes) {
      if (write.resource !== 'transforms' || write.offset !== 0 || write.bytes !== 32) {
        findings.push(`frame ${frameIndex} has a non-target S4 write`);
      }
    }
    return;
  }

  for (const write of writes) {
    if (write.resource !== 'frame' && write.resource !== 'transforms') {
      findings.push(`frame ${frameIndex} writes warmed ${write.resource} data`);
    }
  }
}

function isInWindow(elapsedMs: number, startMs: number, endMs: number): boolean {
  return Number.isFinite(elapsedMs) && elapsedMs >= startMs && elapsedMs < endMs;
}

/**
 * Validates observed P1 callbacks and summarizes adjacent RAF callback intervals.
 * The function deliberately never removes a finite long or failed-frame interval.
 */
export function summarizeP1Frames(
  frames: readonly P1FrameObservation[],
  options: Readonly<{ scenario: P1Scenario; startMs: number; endMs: number }>,
): P1FrameSummary {
  const findings: string[] = [];
  const intervals: number[] = [];

  if (!Number.isFinite(options.startMs) || !Number.isFinite(options.endMs)) {
    findings.push('measurement window boundaries must be finite');
  } else if (options.startMs >= options.endMs) {
    findings.push('measurement window must have positive duration');
  }

  let windowGeneration: number | undefined;
  let previous: P1FrameObservation | undefined;

  frames.forEach((frame, frameIndex) => {
    if (!Number.isFinite(frame.timestampMs))
      findings.push(`frame ${frameIndex} timestamp is not finite`);
    if (!Number.isFinite(frame.elapsedMs))
      findings.push(`frame ${frameIndex} elapsed time is not finite`);

    if (previous !== undefined) {
      if (
        Number.isFinite(previous.timestampMs) &&
        Number.isFinite(frame.timestampMs) &&
        frame.timestampMs <= previous.timestampMs
      ) {
        findings.push(`frame ${frameIndex} timestamp is not strictly monotonic`);
      }
      if (
        Number.isFinite(previous.elapsedMs) &&
        Number.isFinite(frame.elapsedMs) &&
        frame.elapsedMs <= previous.elapsedMs
      ) {
        findings.push(`frame ${frameIndex} elapsed time is not strictly monotonic`);
      }
      if (
        Number.isFinite(previous.timestampMs) &&
        Number.isFinite(frame.timestampMs) &&
        Number.isFinite(previous.elapsedMs) &&
        Number.isFinite(frame.elapsedMs)
      ) {
        const timestampDelta = frame.timestampMs - previous.timestampMs;
        const elapsedDelta = frame.elapsedMs - previous.elapsedMs;
        if (Math.abs(timestampDelta - elapsedDelta) > 1e-6) {
          findings.push(`frame ${frameIndex} timestamp and elapsed-time deltas disagree`);
        }

        if (
          isInWindow(previous.elapsedMs, options.startMs, options.endMs) &&
          isInWindow(frame.elapsedMs, options.startMs, options.endMs)
        ) {
          intervals.push(timestampDelta);
        }
      }
    }

    if (isInWindow(frame.elapsedMs, options.startMs, options.endMs)) {
      if (!Number.isInteger(frame.generation) || frame.generation <= 0) {
        findings.push(`frame ${frameIndex} has an invalid generation`);
      } else if (windowGeneration === undefined) {
        windowGeneration = frame.generation;
      } else if (frame.generation !== windowGeneration) {
        findings.push(`frame ${frameIndex} changes the current generation`);
      }

      if (frame.sceneRevision === null || !isNonNegativeInteger(frame.sceneRevision)) {
        findings.push(`frame ${frameIndex} is missing a valid scene revision`);
      }
      if (frame.cameraRevision === null || !isNonNegativeInteger(frame.cameraRevision)) {
        findings.push(`frame ${frameIndex} is missing a valid camera revision`);
      }
      if (frame.submissionCount !== 1) {
        findings.push(
          `frame ${frameIndex} has ${frame.submissionCount} submissions instead of one`,
        );
      }
      if (frame.packetCount !== 1) {
        findings.push(`frame ${frameIndex} has ${frame.packetCount} packets instead of one`);
      }

      const expectedVisible = EXPECTED_VISIBLE[options.scenario];
      if (frame.visibleCount !== expectedVisible) {
        findings.push(
          `frame ${frameIndex} observes ${String(frame.visibleCount)} visible instances; expected ${expectedVisible}`,
        );
      }
      if (frame.drawInstanceCount !== expectedVisible) {
        findings.push(
          `frame ${frameIndex} draws ${frame.drawInstanceCount} instances; expected ${expectedVisible}`,
        );
      }
      if (!frame.visible)
        findings.push(`frame ${frameIndex} was captured while the document was hidden`);
      if (frame.errors.length > 0) findings.push(`frame ${frameIndex} contains unexpected errors`);
      if (frame.pipelineCreations !== 0) {
        findings.push(`frame ${frameIndex} creates warmed pipelines`);
      }
      if (frame.shaderCreations !== 0) findings.push(`frame ${frameIndex} creates warmed shaders`);

      validateWrites(options.scenario, frame.writes, frameIndex, findings);
    }

    previous = frame;
  });

  if (intervals.length === 0) findings.push('measurement window contains no callback intervals');

  return Object.freeze({
    intervals: Object.freeze(intervals),
    summary: summarize(intervals),
    findings: Object.freeze(findings),
    disposition: 'FUNCTIONAL_ONLY',
  });
}
