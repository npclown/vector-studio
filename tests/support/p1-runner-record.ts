import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { P1FunctionalCapture } from '../../apps/playground/src/p1-runner.js';
import {
  zeroP1CpuStatistics,
  type P1CpuStatistics,
} from '../../apps/playground/src/p1-run-metrics.js';
import {
  p1MeasurementWindow,
  p1RunConfiguration,
  summarizeP1RunFrames,
  type P1ProfileName,
} from '../../apps/playground/src/p1-run-profiles.js';
import { p1Source } from './p1-evidence.js';
// @ts-expect-error The dependency-free CLI exposes the shared metadata validator from .mjs.
import * as cli from '../../tooling/run-p1-benchmark.mjs';

export type P1Source = ReturnType<typeof p1Source>;
export type P1ReferenceEnvironment = Readonly<{
  observedAt: string;
  displayRefreshHz: Readonly<{ value: number; source: string }>;
  power: Readonly<{ value: string; source: string }>;
  backgroundLoad: Readonly<{ value: string; source: string }>;
  driver: Readonly<{ value: string; source: string }>;
  display: Readonly<{ value: string; source: string }>;
}>;

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

export function validateReferenceEnvironment(value: unknown): string[] {
  try {
    (
      cli as unknown as { validateP1Environment: (value: unknown) => P1ReferenceEnvironment }
    ).validateP1Environment(value);
    return [];
  } catch (error) {
    return [String(error)];
  }
}

function cpuTotal(frames: P1FunctionalCapture['frames']): P1CpuStatistics {
  const total = zeroP1CpuStatistics();
  return frames.reduce(
    (result, frame) => ({
      geometryBuilds: result.geometryBuilds + frame.cpu.geometryBuilds,
      recordWrites: {
        transforms: result.recordWrites.transforms + frame.cpu.recordWrites.transforms,
        geometry: result.recordWrites.geometry + frame.cpu.recordWrites.geometry,
        styles: result.recordWrites.styles + frame.cpu.recordWrites.styles,
        order: result.recordWrites.order + frame.cpu.recordWrites.order,
        frame: result.recordWrites.frame + frame.cpu.recordWrites.frame,
      },
    }),
    total,
  );
}

export function functionalFindings(capture: P1FunctionalCapture): string[] {
  const profileName = capture.profile.name;
  const metrics = summarizeP1RunFrames(capture.frames, capture.scenario, profileName);
  const findings = [...metrics.findings, ...capture.errors];
  if (p1Hash(capture.profile) !== p1Hash(p1RunConfiguration(profileName).profile))
    findings.push('Record profile differs from frozen runner profile.');
  if (
    profileName === 'functional' &&
    (capture.frames.length !== 8 || metrics.intervals.length !== 4)
  )
    findings.push('Expected 3 warmup + 5 observed callbacks and 4 intervals.');
  if (p1Hash(metrics) !== p1Hash(capture.metrics))
    findings.push('Recorded metrics disagree with raw callbacks.');
  if (p1Hash(capture.configuration) !== p1Hash(p1RunConfiguration(profileName)))
    findings.push('Configuration differs from frozen runner configuration.');
  if (p1Hash(capture.cpuTotals) !== p1Hash(cpuTotal(capture.frames)))
    findings.push('CPU totals disagree with raw callbacks.');
  if (
    p1Hash(capture.window) !==
    p1Hash(p1MeasurementWindow(capture.scenario, profileName, capture.frames))
  )
    findings.push('Window differs from frozen profile boundaries.');
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
  if (
    capture.environment.observedTimerIncrementsMs.some(
      (value) => !Number.isFinite(value) || value <= 0,
    )
  )
    findings.push('Observed timer increments are invalid.');
  if (
    capture.environment.cssSize.width !== 1280 ||
    capture.environment.cssSize.height !== 720 ||
    capture.environment.physicalSize.width !== 1280 ||
    capture.environment.physicalSize.height !== 720 ||
    capture.environment.devicePixelRatio !== 1
  )
    findings.push('Surface differs from frozen workload.');
  const disposed = capture.disposed;
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
  return findings;
}

function environmentMetadata(profile: P1ProfileName): P1ReferenceEnvironment | null {
  if (profile === 'functional') return null;
  try {
    return JSON.parse(process.env.P1_RUNNER_ENVIRONMENT ?? '') as P1ReferenceEnvironment;
  } catch {
    return null;
  }
}

export function createP1FunctionalRecord(
  capture: P1FunctionalCapture,
  source: P1Source,
  browser: { name: string; version: string },
  browserErrors: readonly string[],
  repetition = 1,
) {
  const profileName = capture.profile.name;
  const metadata = environmentMetadata(profileName);
  const record = {
    schema: 'p1-observed-run/v2',
    createdAt: new Date().toISOString(),
    disposition: '',
    acceptance: { P1: 'UNVERIFIED', A09: 'UNVERIFIED', A10: 'UNVERIFIED' },
    criteria: {
      A05: 'UNVERIFIED',
      A08: 'UNVERIFIED',
    },
    repetition,
    findings: [] as string[],
    browserErrors,
    source,
    configurationSha256: p1Hash(capture.configuration),
    command: JSON.parse(process.env.P1_RUNNER_COMMAND ?? JSON.stringify(process.argv)) as string[],
    buildMode: process.env.P1_RUNNER_BUILD_MODE ?? 'development',
    environment: {
      browser,
      os: { platform: os.platform(), release: os.release(), version: os.version() },
      cpu: os.cpus()[0]?.model,
      logicalCores: os.cpus().length,
      installedMemoryBytes: os.totalmem(),
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      profileEnvironment: metadata,
      flags: ['--enable-unsafe-webgpu'],
      headless: profileName === 'functional',
    },
    capture,
  };
  record.findings = observationFindings(record);
  Object.assign(record, classifyRecord(profileName, record.findings));
  return record;
}

type P1Record = ReturnType<typeof createP1FunctionalRecord>;

function observationFindings(record: P1Record): string[] {
  const findings = [...functionalFindings(record.capture), ...record.browserErrors];
  const profileName = record.capture.profile.name;
  if (
    !Number.isSafeInteger(record.repetition) ||
    record.repetition <= 0 ||
    record.repetition > p1RunConfiguration(profileName).profile.repetitions
  )
    findings.push('Repetition identifier is invalid.');
  if (
    !Array.isArray(record.command) ||
    record.command.length === 0 ||
    record.command.some((item) => typeof item !== 'string' || item.length === 0)
  )
    findings.push('Command observation is missing or invalid.');
  if (profileName === 'reference')
    findings.push(...validateReferenceEnvironment(record.environment.profileEnvironment));
  if (profileName === 'reference' && record.buildMode !== 'production')
    findings.push('Reference build mode is not production.');
  if (record.environment.headless !== (profileName === 'functional'))
    findings.push('Browser headed/headless observation disagrees with profile.');
  if (p1Hash(record.environment.flags) !== p1Hash(['--enable-unsafe-webgpu']))
    findings.push('Browser launch flags differ from runner configuration.');
  if (
    !['chrome', 'edge'].includes(record.environment.browser.name) ||
    !record.environment.browser.version
  )
    findings.push('Browser identity is missing or invalid.');
  if (profileName === 'reference') {
    const environment = record.capture.environment;
    if (
      environment.observedTimerIncrementsMs.length === 0 ||
      !Number.isFinite(environment.timeOrigin)
    )
      findings.push('Reference clock observations are missing.');
    if (
      environment.instrumentation.length === 0 ||
      Object.values(environment.windowBounds).some((value) => !Number.isFinite(value)) ||
      environment.windowBounds.innerWidth <= 0 ||
      environment.windowBounds.innerHeight <= 0 ||
      environment.windowBounds.outerWidth <= 0 ||
      environment.windowBounds.outerHeight <= 0
    )
      findings.push('Reference instrumentation or window observations are invalid.');
  }
  return findings;
}

function classifyRecord(profileName: P1ProfileName, findings: readonly string[]) {
  const candidate = findings.length === 0;
  const disposition =
    profileName === 'functional'
      ? candidate
        ? 'FUNCTIONAL_PASS'
        : 'FUNCTIONAL_FAIL'
      : candidate
        ? 'REFERENCE_CANDIDATE'
        : 'REFERENCE_INVALID';
  const criteria = {
    A05: profileName === 'reference' && candidate ? 'CANDIDATE' : 'UNVERIFIED',
    A08: profileName === 'reference' && candidate ? 'CANDIDATE' : 'UNVERIFIED',
  };
  return { disposition, criteria };
}

function integrityFindings(record: P1Record, observed: readonly string[]): string[] {
  const findings: string[] = [];
  const expected = classifyRecord(record.capture.profile.name, observed);
  if (record.schema !== 'p1-observed-run/v2') findings.push('Record schema is invalid.');
  if (
    p1Hash(record.acceptance) !== p1Hash({ P1: 'UNVERIFIED', A09: 'UNVERIFIED', A10: 'UNVERIFIED' })
  )
    findings.push('Record claims unsupported acceptance.');
  if (p1Hash(observed) !== p1Hash(record.findings))
    findings.push('Record findings disagree with raw capture.');
  if (record.disposition !== expected.disposition)
    findings.push('Record disposition disagrees with raw capture.');
  if (p1Hash(record.criteria) !== p1Hash(expected.criteria))
    findings.push('Record criteria disagree with raw capture.');
  if (record.configurationSha256 !== p1Hash(record.capture.configuration))
    findings.push('Record configuration hash disagrees with raw capture.');
  return findings;
}

export function recordFindings(record: P1Record): string[] {
  const observed = observationFindings(record);
  return [...observed, ...integrityFindings(record, observed)];
}

export function writeP1FunctionalRecord(
  directory: string,
  record: ReturnType<typeof createP1FunctionalRecord>,
  endSource: P1Source,
): void {
  mkdirSync(directory);
  // Retain the supplied observation and its end provenance even when validation rejects it.
  writeFileSync(path.join(directory, 'record.json'), `${JSON.stringify(record, null, 2)}\n`, {
    flag: 'wx',
  });
  writeFileSync(
    path.join(directory, 'source-end.json'),
    `${JSON.stringify(endSource, null, 2)}\n`,
    { flag: 'wx' },
  );
  const sourceDrift = p1Hash(record.source) !== p1Hash(endSource);
  if (sourceDrift) {
    writeFileSync(
      path.join(directory, 'source-drift.json'),
      `${JSON.stringify({ start: record.source, end: endSource }, null, 2)}\n`,
      { flag: 'wx' },
    );
    throw new Error('Source drift during runner capture.');
  }
  const observed = observationFindings(record);
  const integrity = integrityFindings(record, observed);
  writeFileSync(
    path.join(directory, 'validation.json'),
    `${JSON.stringify({ observed, integrity }, null, 2)}\n`,
    { flag: 'wx' },
  );
  if (integrity.length > 0) throw new Error('Inconsistent runner evidence or acceptance claim.');
}
