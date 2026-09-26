import {
  summarizeP1Frames,
  type P1FrameObservation,
  type P1FrameSummary,
} from './p1-run-metrics.js';
import { P1_CONFIGURATION, type P1Scenario } from './p1-workloads.js';

export type P1ProfileName = 'functional' | 'reference';

export const P1_PROFILES = Object.freeze({
  functional: Object.freeze({
    name: 'functional',
    warmupFrames: 3,
    measuredFrames: 5,
    repetitions: 1,
  }),
  reference: Object.freeze({
    name: 'reference',
    warmupMs: 5_000,
    measuredMs: 10_000,
    repetitions: 5,
  }),
} as const);

export const P1_RUNNER_VERSION = 'p1-observed-runner/v2';

export type P1MeasurementWindow = Readonly<{
  scenario: P1Scenario;
  startMs: number;
  endMs: number;
}>;

export type P1RunFrameSummary = Omit<P1FrameSummary, 'findings' | 'disposition'> &
  Readonly<{
    findings: readonly string[];
    disposition: 'FUNCTIONAL_ONLY' | 'REFERENCE_CANDIDATE';
  }>;

export function p1RunConfiguration(profileName: P1ProfileName) {
  return {
    version: P1_RUNNER_VERSION,
    workload: P1_CONFIGURATION,
    profile: P1_PROFILES[profileName],
  };
}

export function p1MeasurementWindow(
  scenario: P1Scenario,
  profileName: P1ProfileName,
  frames: readonly P1FrameObservation[],
): P1MeasurementWindow {
  if (profileName === 'reference') {
    return { scenario, startMs: 5_000, endMs: 15_000 };
  }

  return {
    scenario,
    startMs: frames[3]?.elapsedMs ?? Number.NaN,
    endMs: (frames.at(-1)?.elapsedMs ?? Number.NaN) + 1,
  };
}

export function p1LastCallback(
  profileName: P1ProfileName,
  completedCount: number,
  elapsedMs: number,
): boolean {
  return profileName === 'functional' ? completedCount >= 7 : elapsedMs >= 15_000;
}

function validateCallbackIntegrity(
  frames: readonly P1FrameObservation[],
  scenario: P1Scenario,
  warmupEndMs: number,
  findings: string[],
): void {
  const expectedVisible = P1_CONFIGURATION.scenarios[scenario].expectedVisible;
  frames.forEach((frame, frameIndex) => {
    if (!Number.isInteger(frame.generation) || frame.generation <= 0) {
      findings.push(`frame ${frameIndex} has an invalid generation`);
    } else if (frameIndex > 0 && frame.generation !== frames[0]?.generation) {
      findings.push(`frame ${frameIndex} changes the current generation`);
    }
    if (
      frame.sceneRevision === null ||
      !Number.isInteger(frame.sceneRevision) ||
      frame.sceneRevision < 0
    ) {
      findings.push(`frame ${frameIndex} is missing a valid scene revision`);
    }
    if (
      frame.cameraRevision === null ||
      !Number.isInteger(frame.cameraRevision) ||
      frame.cameraRevision < 0
    ) {
      findings.push(`frame ${frameIndex} is missing a valid camera revision`);
    }
    if (frame.submissionCount !== 1) {
      findings.push(`frame ${frameIndex} has ${frame.submissionCount} submissions instead of one`);
    }
    if (frame.packetCount !== 1) {
      findings.push(`frame ${frameIndex} has ${frame.packetCount} packets instead of one`);
    }
    if (frame.visibleCount !== expectedVisible) {
      findings.push(`frame ${frameIndex} has an invalid visible count`);
    }
    if (frame.drawInstanceCount !== expectedVisible) {
      findings.push(`frame ${frameIndex} has an invalid native instance count`);
    }
    if (!frame.visible) findings.push(`frame ${frameIndex} was captured while hidden`);
    if (frame.errors.length > 0) findings.push(`frame ${frameIndex} contains unexpected errors`);
    if (frame.elapsedMs >= warmupEndMs && frame.pipelineCreations !== 0) {
      findings.push(`frame ${frameIndex} creates warmed pipelines`);
    }
    if (frame.elapsedMs >= warmupEndMs && frame.shaderCreations !== 0) {
      findings.push(`frame ${frameIndex} creates warmed shaders`);
    }
  });
}

function validateWarmupCpuObservation(
  frames: readonly P1FrameObservation[],
  warmupEndMs: number,
  requiredGeometryBuilds: number,
  findings: string[],
): void {
  const warmupGeometryBuilds = frames.reduce(
    (total, frame) =>
      frame.elapsedMs >= 0 && frame.elapsedMs < warmupEndMs
        ? total + frame.cpu.geometryBuilds
        : total,
    0,
  );
  if (warmupGeometryBuilds < requiredGeometryBuilds) {
    findings.push(
      `warm-up geometry builds ${warmupGeometryBuilds} are below required ${requiredGeometryBuilds}`,
    );
  }
}

function validateReferenceBoundary(
  frames: readonly P1FrameObservation[],
  findings: string[],
): void {
  if (frames[0]?.elapsedMs !== 0) findings.push('reference run must start at elapsed time 0');

  const finalIndex = frames.length - 1;
  const finalFrame = frames.at(-1);
  if (finalFrame === undefined || !(finalFrame.elapsedMs >= 15_000)) {
    findings.push('reference run must retain a final sample at or after 15000 ms');
  }

  frames.forEach((frame, frameIndex) => {
    if (frameIndex < finalIndex && !(frame.elapsedMs < 15_000)) {
      findings.push(
        `reference frame ${frameIndex} is at or after 15000 ms before the final sample`,
      );
    }
  });
}

export function summarizeP1RunFrames(
  frames: readonly P1FrameObservation[],
  scenario: P1Scenario,
  profileName: P1ProfileName,
): P1RunFrameSummary {
  const window = p1MeasurementWindow(scenario, profileName, frames);
  const summary = summarizeP1Frames(frames, window);
  const findings = [...summary.findings];

  if (profileName === 'functional') {
    if (frames.length !== 8) findings.push('functional run must contain exactly 8 callbacks');
    validateCallbackIntegrity(frames, scenario, window.startMs, findings);
    validateWarmupCpuObservation(frames, window.startMs, 1, findings);
    return Object.freeze({
      ...summary,
      findings: Object.freeze(findings),
      disposition: 'FUNCTIONAL_ONLY',
    });
  }

  validateCallbackIntegrity(frames, scenario, window.startMs, findings);
  validateWarmupCpuObservation(
    frames,
    window.startMs,
    P1_CONFIGURATION.scenarios[scenario].population,
    findings,
  );
  validateReferenceBoundary(frames, findings);
  return Object.freeze({
    ...summary,
    findings: Object.freeze(findings),
    disposition: findings.length === 0 ? 'REFERENCE_CANDIDATE' : 'FUNCTIONAL_ONLY',
  });
}
