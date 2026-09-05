import { createHash } from 'node:crypto';
import { closeSync, mkdirSync, openSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export const P0_BENCHMARK_SCHEMA = 'vector-studio/p0-benchmark-result/v1' as const;
export const P0_RUNNER_ID = 'vector-studio/p0-runner/v1' as const;

export type JsonValue =
  null | boolean | number | string | readonly JsonValue[] | { readonly [key: string]: JsonValue };

export interface AvailableMetric {
  readonly availability: 'available';
  readonly value: number;
  readonly unit: string;
  readonly clock: string;
  readonly startEvent: string;
  readonly endEvent: string;
  readonly observation: string;
}

export interface UnavailableMetric {
  readonly availability: 'unavailable';
  readonly reason: string;
  readonly unit: string;
  readonly clock: string;
  readonly startEvent: string;
  readonly endEvent: string;
  readonly observation: string;
}

export type BenchmarkMetric = AvailableMetric | UnavailableMetric;

export interface P0BenchmarkRepetition {
  readonly index: number;
  readonly startedAtUtc: string;
  readonly endedAtUtc: string;
  readonly window: {
    readonly clock: string;
    readonly startMs: number;
    readonly endMs: number;
  };
  readonly sampleCounts: Readonly<Record<string, number>>;
  readonly samples: Readonly<Record<string, readonly number[]>>;
  readonly metrics: Readonly<Record<string, BenchmarkMetric>>;
  readonly diagnostics: {
    readonly expected: readonly JsonValue[];
    readonly unexpected: readonly JsonValue[];
  };
}

export interface P0BenchmarkRecord {
  readonly schema: typeof P0_BENCHMARK_SCHEMA;
  readonly status: 'Exploratory';
  readonly identity: {
    readonly revision: string;
    readonly sourceState: 'clean' | 'dirty';
    readonly sourceDelta?: string;
    readonly runId: string;
    readonly timestampUtc: string;
    readonly localTimezone: string;
  };
  readonly runner: {
    readonly id: typeof P0_RUNNER_ID;
    readonly command: string;
    readonly buildMode: 'production';
  };
  readonly environment: Readonly<Record<string, JsonValue>>;
  readonly scenario: {
    readonly id: string;
    readonly version: number;
    readonly seed: number;
    readonly profile: 'smoke' | 'acceptance';
    readonly configuration: JsonValue;
    readonly configurationHash: string;
  };
  readonly repetitions: readonly P0BenchmarkRepetition[];
}

export interface BenchmarkArtifactPaths {
  readonly json: string;
  readonly markdown: string;
}

const REQUIRED_ENVIRONMENT_FIELDS = Object.freeze([
  'operatingSystem',
  'cpu',
  'logicalCores',
  'installedMemoryBytes',
  'gpu',
  'browser',
  'browserLaunchFlags',
  'displayRefreshRate',
  'selectedFeatures',
  'sampleCount',
  'viewport',
  'power',
] as const);

function canonicalize(value: JsonValue): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('Canonical JSON numbers must be finite.');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${(value as readonly JsonValue[]).map((entry) => canonicalize(entry)).join(',')}]`;
  }
  const objectValue = value as { readonly [key: string]: JsonValue };
  return `{${Object.keys(objectValue)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalize(objectValue[key] as JsonValue)}`)
    .join(',')}}`;
}

export function canonicalJson(value: JsonValue): string {
  return canonicalize(value);
}

export function configurationHash(configuration: JsonValue): string {
  return createHash('sha256').update(canonicalJson(configuration), 'utf8').digest('hex');
}

function isNonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

function isUtcTimestamp(value: unknown): value is string {
  return (
    isNonEmpty(value) &&
    value.endsWith('Z') &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value
  );
}

function validateMetric(name: string, metric: BenchmarkMetric, issues: string[]): void {
  if (!isNonEmpty(metric.unit)) issues.push(`${name}.unit must be non-empty.`);
  if (!isNonEmpty(metric.clock)) issues.push(`${name}.clock must be non-empty.`);
  if (!isNonEmpty(metric.startEvent)) issues.push(`${name}.startEvent must be non-empty.`);
  if (!isNonEmpty(metric.endEvent)) issues.push(`${name}.endEvent must be non-empty.`);
  if (!isNonEmpty(metric.observation)) issues.push(`${name}.observation must be non-empty.`);
  if (metric.availability === 'available') {
    if (!Number.isFinite(metric.value) || metric.value < 0) {
      issues.push(`${name}.value must be a finite non-negative number.`);
    }
  } else if (!isNonEmpty(metric.reason)) {
    issues.push(`${name}.reason must be non-empty when unavailable.`);
  }
}

export function validateP0BenchmarkRecord(record: P0BenchmarkRecord): readonly string[] {
  const issues: string[] = [];
  if (record.schema !== P0_BENCHMARK_SCHEMA) issues.push('schema is unsupported.');
  if (record.status !== 'Exploratory') issues.push('generated status must be Exploratory.');
  if (!/^[0-9a-f]{7,40}$/u.test(record.identity.revision)) {
    issues.push('identity.revision must be a Git object ID.');
  }
  if (!isNonEmpty(record.identity.runId)) issues.push('identity.runId must be non-empty.');
  if (!isUtcTimestamp(record.identity.timestampUtc)) {
    issues.push('identity.timestampUtc must be canonical UTC ISO-8601.');
  }
  if (!isNonEmpty(record.identity.localTimezone)) {
    issues.push('identity.localTimezone must be non-empty.');
  }
  if (record.identity.sourceState === 'dirty' && !isNonEmpty(record.identity.sourceDelta)) {
    issues.push('dirty source requires identity.sourceDelta.');
  }
  if (record.runner.id !== P0_RUNNER_ID) issues.push('runner.id is unsupported.');
  if (!isNonEmpty(record.runner.command)) issues.push('runner.command must be non-empty.');
  for (const field of REQUIRED_ENVIRONMENT_FIELDS) {
    if (!(field in record.environment)) issues.push(`environment.${field} is required.`);
  }
  if (!isNonEmpty(record.scenario.id)) issues.push('scenario.id must be non-empty.');
  if (!Number.isSafeInteger(record.scenario.version) || record.scenario.version <= 0) {
    issues.push('scenario.version must be a positive safe integer.');
  }
  if (!Number.isSafeInteger(record.scenario.seed)) {
    issues.push('scenario.seed must be a safe integer.');
  }
  let actualHash: string | undefined;
  try {
    actualHash = configurationHash(record.scenario.configuration);
  } catch (error: unknown) {
    issues.push(`scenario.configuration is invalid: ${String(error)}`);
  }
  if (actualHash !== undefined && record.scenario.configurationHash !== actualHash) {
    issues.push('scenario.configurationHash does not match canonical configuration.');
  }
  if (record.repetitions.length === 0) issues.push('repetitions must not be empty.');
  for (const [offset, repetition] of record.repetitions.entries()) {
    const prefix = `repetitions[${offset}]`;
    if (repetition.index !== offset + 1) issues.push(`${prefix}.index must be sequential.`);
    if (!isUtcTimestamp(repetition.startedAtUtc)) {
      issues.push(`${prefix}.startedAtUtc must be canonical UTC ISO-8601.`);
    }
    if (!isUtcTimestamp(repetition.endedAtUtc)) {
      issues.push(`${prefix}.endedAtUtc must be canonical UTC ISO-8601.`);
    }
    if (
      isUtcTimestamp(repetition.startedAtUtc) &&
      isUtcTimestamp(repetition.endedAtUtc) &&
      Date.parse(repetition.endedAtUtc) < Date.parse(repetition.startedAtUtc)
    ) {
      issues.push(`${prefix} ends before it starts.`);
    }
    if (!isNonEmpty(repetition.window.clock)) {
      issues.push(`${prefix}.window.clock must be non-empty.`);
    }
    if (
      !Number.isFinite(repetition.window.startMs) ||
      !Number.isFinite(repetition.window.endMs) ||
      repetition.window.startMs < 0 ||
      repetition.window.endMs < repetition.window.startMs
    ) {
      issues.push(`${prefix}.window must contain finite ordered non-negative times.`);
    }
    for (const [name, count] of Object.entries(repetition.sampleCounts)) {
      if (!Number.isSafeInteger(count) || count < 0) {
        issues.push(`${prefix}.sampleCounts.${name} must be a non-negative safe integer.`);
      }
      if (repetition.samples[name]?.length !== count) {
        issues.push(`${prefix}.sampleCounts.${name} does not match samples.`);
      }
    }
    if (!Object.values(repetition.sampleCounts).some((count) => count > 0)) {
      issues.push(`${prefix}.sampleCounts must contain a positive count.`);
    }
    for (const [name, samples] of Object.entries(repetition.samples)) {
      if (samples.some((sample) => !Number.isFinite(sample) || sample < 0)) {
        issues.push(`${prefix}.samples.${name} contains an invalid duration.`);
      }
    }
    for (const [name, metric] of Object.entries(repetition.metrics)) {
      validateMetric(`${prefix}.metrics.${name}`, metric, issues);
    }
  }
  return Object.freeze(issues);
}

function slug(value: string): string {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9.-]+/gu, '-')
    .replace(/^-+|-+$/gu, '');
  if (normalized === '') throw new TypeError('Artifact name component cannot be empty.');
  return normalized;
}

export function benchmarkArtifactBaseName(
  record: P0BenchmarkRecord,
  browser: string,
  machine: string,
): string {
  const timestamp = record.identity.timestampUtc.replace(/[-:]/gu, '').replace('.000Z', 'Z');
  return `${timestamp}_${slug(record.scenario.id)}-v${record.scenario.version}_${slug(browser)}_${slug(machine)}_${slug(record.identity.runId)}`;
}

export function renderP0BenchmarkMarkdown(record: P0BenchmarkRecord): string {
  const metricNames = [
    ...new Set(record.repetitions.flatMap((repetition) => Object.keys(repetition.metrics))),
  ].sort();
  const rows = metricNames.map((name) => {
    const values = record.repetitions.map((repetition) => {
      const metric = repetition.metrics[name];
      if (!metric) return 'missing';
      return metric.availability === 'available'
        ? `${metric.value} ${metric.unit}`
        : `UNAVAILABLE: ${metric.reason}`;
    });
    return `| ${name} | ${values.join(' | ')} |`;
  });
  const headings = record.repetitions.map(({ index }) => `Run ${index}`);
  return `# Benchmark result: ${record.scenario.id}/v${record.scenario.version}\n\nStatus: Exploratory\n\n## Identity\n\n- Revision: ${record.identity.revision}\n- Run ID: ${record.identity.runId}\n- Timestamp UTC: ${record.identity.timestampUtc}\n- Configuration hash: ${record.scenario.configurationHash}\n- Profile: ${record.scenario.profile}\n\n## Results\n\n| Metric | ${headings.join(' | ')} |\n| --- | ${headings.map(() => '---:').join(' | ')} |\n${rows.join('\n')}\n\n## Gate\n\nThis generated observation is not accepted automatically. Link an execution-plan review before using it as a baseline.\n`;
}

export function writeP0BenchmarkArtifacts(
  record: P0BenchmarkRecord,
  directory: string,
  browser: string,
  machine: string,
): BenchmarkArtifactPaths {
  const issues = validateP0BenchmarkRecord(record);
  if (issues.length > 0) throw new TypeError(`Invalid P0 benchmark record:\n${issues.join('\n')}`);
  mkdirSync(directory, { recursive: true });
  const base = path.join(directory, benchmarkArtifactBaseName(record, browser, machine));
  const paths = { json: `${base}.json`, markdown: `${base}.md` };
  let jsonHandle: number | undefined;
  let markdownHandle: number | undefined;
  try {
    jsonHandle = openSync(paths.json, 'wx');
    markdownHandle = openSync(paths.markdown, 'wx');
    writeFileSync(jsonHandle, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
    writeFileSync(markdownHandle, renderP0BenchmarkMarkdown(record), 'utf8');
  } catch (error: unknown) {
    if (jsonHandle !== undefined) {
      closeSync(jsonHandle);
      jsonHandle = undefined;
      unlinkSync(paths.json);
    }
    if (markdownHandle !== undefined) {
      closeSync(markdownHandle);
      markdownHandle = undefined;
      unlinkSync(paths.markdown);
    }
    throw error;
  } finally {
    if (jsonHandle !== undefined) closeSync(jsonHandle);
    if (markdownHandle !== undefined) closeSync(markdownHandle);
  }
  return Object.freeze(paths);
}
