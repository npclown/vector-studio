import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { P1FunctionalCapture } from '../../apps/playground/src/p1-runner.js';
import { summarizeP1Frames } from '../../apps/playground/src/p1-run-metrics.js';
import { P1_CONFIGURATION } from '../../apps/playground/src/p1-workloads.js';
import { p1Source } from './p1-evidence.js';

export type P1Source = ReturnType<typeof p1Source>;
export function p1Hash(value: unknown): string {
  return createHash('sha256')
    .update(
      JSON.stringify(value, (_key, item: unknown) =>
        item !== null && typeof item === 'object' && !Array.isArray(item)
          ? Object.fromEntries(
              Object.entries(item).sort(([left], [right]) =>
                left < right ? -1 : left > right ? 1 : 0,
              ),
            )
          : item,
      ),
    )
    .digest('hex');
}

export function functionalFindings(capture: P1FunctionalCapture): string[] {
  const metrics = summarizeP1Frames(capture.frames, capture.window);
  const findings = [...metrics.findings, ...capture.errors];
  if (p1Hash(metrics) !== p1Hash(capture.metrics))
    findings.push('Recorded metrics disagree with raw callbacks.');
  if (p1Hash(capture.configuration) !== p1Hash(P1_CONFIGURATION))
    findings.push('Configuration differs from frozen workloads.');
  if (capture.frames.length !== 8 || metrics.intervals.length !== 4)
    findings.push('Expected 3 warmup + 5 observed callbacks and 4 intervals.');
  if (
    capture.profile.name !== 'functional' ||
    capture.profile.warmupFrames !== 3 ||
    capture.profile.measuredFrames !== 5
  )
    findings.push('Unexpected profile.');
  if (
    capture.window.scenario !== capture.scenario ||
    capture.window.startMs !== capture.frames[3]?.elapsedMs ||
    capture.window.endMs !== (capture.frames[7]?.elapsedMs ?? NaN) + 1
  )
    findings.push('Window differs from functional callback boundaries.');
  if (capture.maximumPendingCallbacks !== 1 || capture.pendingCallbacksAfterDispose !== 0)
    findings.push('Invalid observed RAF ownership or cleanup.');
  if (!capture.capability?.supported || capture.capability.capabilities.sampleCount !== 4)
    findings.push('Native 4x capability absent.');
  if (
    capture.diagnostics.some((event) => event.severity === 'error') ||
    capture.frames.some((frame) => frame.errors.length > 0)
  )
    findings.push('Renderer error observed.');
  if (
    capture.visibility.some((event) => event.state !== 'visible') ||
    capture.environment.visibilityState !== 'visible' ||
    capture.frames.some((frame) => !frame.visible)
  )
    findings.push('Hidden document observed.');
  const { disposed } = capture;
  if (
    disposed.lifecycle !== 'disposed' ||
    disposed.pendingFrameCallbacks !== 0 ||
    disposed.deviceListeners !== 0 ||
    disposed.diagnosticListeners !== 0 ||
    Object.values(disposed.resources.byCategory).some(
      (category) => category.live !== 0 || category.liveBytes !== 0,
    )
  )
    findings.push('Resources or listeners remain after disposal.');
  const { cssSize, physicalSize, devicePixelRatio } = capture.environment;
  if (
    cssSize.width !== 1280 ||
    cssSize.height !== 720 ||
    physicalSize.width !== 1280 ||
    physicalSize.height !== 720 ||
    devicePixelRatio !== 1
  )
    findings.push('Surface differs from frozen workload.');
  return findings;
}

export function createP1FunctionalRecord(
  capture: P1FunctionalCapture,
  source: P1Source,
  browser: { name: string; version: string },
  browserErrors: readonly string[],
) {
  const findings = [...functionalFindings(capture), ...browserErrors];
  return {
    schema: 'p1-functional-run/v1',
    createdAt: new Date().toISOString(),
    disposition: findings.length === 0 ? 'FUNCTIONAL_PASS' : 'FUNCTIONAL_FAIL',
    acceptance: {
      P1: 'UNVERIFIED',
      A05: 'UNVERIFIED',
      A08: 'UNVERIFIED',
      A09: 'UNVERIFIED',
      A10: 'UNVERIFIED',
    },
    findings,
    browserErrors,
    source,
    configurationSha256: p1Hash(capture.configuration),
    command: JSON.parse(process.env.P1_RUNNER_COMMAND ?? '[]') as string[],
    buildMode: process.env.P1_RUNNER_BUILD_MODE ?? 'development',
    environment: {
      browser,
      os: { platform: os.platform(), release: os.release(), version: os.version() },
      cpu: os.cpus()[0]?.model,
      logicalCores: os.cpus().length,
      installedMemoryBytes: os.totalmem(),
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      flags: ['--enable-unsafe-webgpu'],
      headless: true,
      refreshHz: 'UNOBSERVED: functional profile',
      powerSource: 'UNOBSERVED: functional profile',
      backgroundLoad: 'UNOBSERVED: functional profile',
      driver: 'UNOBSERVED: functional profile',
    },
    capture,
  };
}

export function writeP1FunctionalRecord(
  directory: string,
  record: ReturnType<typeof createP1FunctionalRecord>,
  endSource: P1Source,
): void {
  if (p1Hash(record.source) !== p1Hash(endSource))
    throw new Error('Source drift during functional capture.');
  const findings = [...functionalFindings(record.capture), ...record.browserErrors];
  if (
    p1Hash(findings) !== p1Hash(record.findings) ||
    record.disposition !== (findings.length === 0 ? 'FUNCTIONAL_PASS' : 'FUNCTIONAL_FAIL') ||
    record.configurationSha256 !== p1Hash(record.capture.configuration) ||
    Object.values(record.acceptance).some((status) => status !== 'UNVERIFIED')
  )
    throw new Error('Inconsistent functional evidence or acceptance claim.');
  mkdirSync(directory); // Parent run directory already exists; case directory is exclusive.
  writeFileSync(path.join(directory, 'record.json'), `${JSON.stringify(record, null, 2)}\n`, {
    flag: 'wx',
  });
}
