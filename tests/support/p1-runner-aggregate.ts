import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import {
  summarizeP1RunFrames,
  type P1ProfileName,
} from '../../apps/playground/src/p1-run-profiles.js';
import { P1_SCENARIOS, type P1Scenario } from '../../apps/playground/src/p1-workloads.js';
import {
  createP1FunctionalRecord,
  p1Hash,
  recordFindings,
  type P1Source,
} from './p1-runner-record.js';

type RecordValue = ReturnType<typeof createP1FunctionalRecord>;
type CriterionStatus = 'CANDIDATE' | 'FAIL' | 'NOT_APPLICABLE' | 'UNVERIFIED';
type SourceMarker = Readonly<{ profile?: unknown; source?: unknown; error?: unknown }>;

const browsers = ['chrome', 'edge'] as const;
const ceilings: Readonly<Partial<Record<P1Scenario, number>>> = Object.freeze({
  'p1-pan-zoom-1k/v1': 16.7,
  'p1-pan-zoom-10k/v1': 33.3,
  'p1-cull-10k/v1': 16.7,
});

export type P1AggregateGroup = Readonly<{
  scenario: P1Scenario;
  browser: (typeof browsers)[number];
  profile: P1ProfileName;
  repetitions: readonly number[];
  maxP95Ms: number | null;
  ceilingMs: number | null;
  criteria: Readonly<{ A05: CriterionStatus; A08: CriterionStatus }>;
  findings: readonly string[];
}>;

export type P1Aggregate = Readonly<{
  profile: P1ProfileName | null;
  criteria: Readonly<{ A05: CriterionStatus; A08: CriterionStatus }>;
  groups: readonly P1AggregateGroup[];
  findings: readonly string[];
}>;

function parseJson(file: string, findings: string[], label: string): unknown {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as unknown;
  } catch (error) {
    findings.push(`${label} could not be read: ${String(error)}`);
    return null;
  }
}

function readMarker(root: string, name: string, findings: string[]): SourceMarker | null {
  const file = path.join(root, name);
  if (!existsSync(file)) {
    findings.push(`${name} is missing.`);
    return null;
  }
  const value = parseJson(file, findings, name);
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    findings.push(`${name} is invalid.`);
    return null;
  }
  return value;
}

function isSource(value: unknown): value is P1Source {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.baseCommit !== 'string' ||
    !/^[0-9a-f]{40}$/u.test(candidate.baseCommit) ||
    typeof candidate.worktree !== 'string' ||
    typeof candidate.manifestSha256 !== 'string' ||
    !/^[0-9a-f]{64}$/u.test(candidate.manifestSha256) ||
    !Array.isArray(candidate.files) ||
    candidate.files.length === 0
  )
    return false;
  const paths = new Set<string>();
  for (const item of candidate.files) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) return false;
    const file = item as Record<string, unknown>;
    if (
      typeof file.path !== 'string' ||
      file.path === '' ||
      path.isAbsolute(file.path) ||
      path.normalize(file.path) === '..' ||
      path.normalize(file.path).startsWith(`..${path.sep}`) ||
      paths.has(file.path) ||
      typeof file.sha256 !== 'string' ||
      !/^[0-9a-f]{64}$/u.test(file.sha256)
    )
      return false;
    paths.add(file.path);
  }
  return true;
}

function readRecords(
  root: string,
  findings: string[],
): Readonly<{ values: RecordValue[]; externalFindings: Map<RecordValue, readonly string[]> }> {
  const result: RecordValue[] = [];
  const externalFindings = new Map<RecordValue, readonly string[]>();
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const directory = path.join(root, entry.name);
    const recordFile = path.join(directory, 'record.json');
    if (!existsSync(recordFile)) {
      findings.push(`${entry.name}/record.json is missing.`);
      continue;
    }
    const value = parseJson(recordFile, findings, `${entry.name}/record.json`);
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      findings.push(`${entry.name}/record.json is invalid.`);
      continue;
    }
    const record = value as RecordValue;
    result.push(record);
    const recordFindings: string[] = [];
    const sourceEndFile = path.join(directory, 'source-end.json');
    if (!existsSync(sourceEndFile)) recordFindings.push('source-end.json is missing.');
    else {
      const sourceEnd = parseJson(sourceEndFile, recordFindings, `${entry.name}/source-end.json`);
      if (sourceEnd === null || typeof sourceEnd !== 'object' || Array.isArray(sourceEnd))
        recordFindings.push('source-end.json is invalid.');
      else {
        const end = sourceEnd as Record<string, unknown>;
        const endSource = 'source' in end ? end.source : end;
        if (!isSource(endSource)) recordFindings.push('source-end.json source is invalid.');
        else if (!isSource(record.source))
          recordFindings.push('record source is missing or invalid.');
        else if (p1Hash(endSource) !== p1Hash(record.source))
          recordFindings.push('source differs from its per-repetition end capture.');
      }
    }
    if (existsSync(path.join(directory, 'source-drift.json')))
      recordFindings.push('source-drift.json records source drift.');
    externalFindings.set(record, Object.freeze(recordFindings));
  }
  return { values: result, externalFindings };
}

function profileFrom(marker: SourceMarker | null, findings: string[]): P1ProfileName | null {
  if (marker?.profile === 'functional' || marker?.profile === 'reference') return marker.profile;
  findings.push('Run-start profile is missing or invalid.');
  return null;
}

function sourceFrom(
  marker: SourceMarker | null,
  name: string,
  findings: string[],
): P1Source | null {
  if (marker?.error !== undefined) findings.push(`${name} records a source capture error.`);
  if (!isSource(marker?.source)) {
    findings.push(`${name} source is missing or invalid.`);
    return null;
  }
  return marker.source;
}

function compatibleEnvironment(record: RecordValue): unknown {
  return {
    browser: record.environment.browser,
    os: record.environment.os,
    cpu: record.environment.cpu,
    logicalCores: record.environment.logicalCores,
    installedMemoryBytes: record.environment.installedMemoryBytes,
    timezone: record.environment.timezone,
    profileEnvironment: record.environment.profileEnvironment,
    flags: record.environment.flags,
    headless: record.environment.headless,
    capability: record.capture.capability?.supported
      ? record.capture.capability.capabilities
      : record.capture.capability,
  };
}

function inspectRecord(record: RecordValue, label: string, findings: string[]): boolean {
  try {
    const rawFindings = recordFindings(record);
    for (const finding of rawFindings) findings.push(`${label}: ${finding}`);
    return rawFindings.length === 0;
  } catch (error) {
    findings.push(`${label} could not be validated from raw evidence: ${String(error)}`);
    return false;
  }
}

function groupRecords(
  values: readonly RecordValue[],
  scenario: P1Scenario,
  browser: (typeof browsers)[number],
): RecordValue[] {
  return values.filter(
    (record) =>
      record.capture?.scenario === scenario && record.environment?.browser?.name === browser,
  );
}

function aggregateGroup(
  values: readonly RecordValue[],
  scenario: P1Scenario,
  browser: (typeof browsers)[number],
  profile: P1ProfileName,
  startSource: P1Source | null,
  endSource: P1Source | null,
  browserCompatibility: Map<string, string>,
  externalFindings: ReadonlyMap<RecordValue, readonly string[]>,
  globalEligible: boolean,
): P1AggregateGroup {
  const findings: string[] = [];
  const group = groupRecords(values, scenario, browser);
  const expectedCount = profile === 'reference' ? 5 : 1;
  const expectedRepetitions = Array.from({ length: expectedCount }, (_, index) => index + 1);
  const repetitions = group
    .map((record) => record.repetition)
    .filter((value): value is number => Number.isInteger(value))
    .sort((left, right) => left - right);
  if (
    repetitions.length !== expectedCount ||
    repetitions.some((value, index) => value !== expectedRepetitions[index])
  )
    findings.push(
      `Expected unique repetitions ${expectedRepetitions.join(', ')}; observed ${repetitions.join(', ') || 'none'}.`,
    );

  const validRecords = new Set<RecordValue>();
  for (const record of group) {
    const label = `repetition ${String(record.repetition)}`;
    const external = externalFindings.get(record) ?? [];
    for (const finding of external) findings.push(`${label}: ${finding}`);
    if (!inspectRecord(record, label, findings)) continue;
    if (external.length === 0) validRecords.add(record);
    if (record.capture.profile.name !== profile)
      findings.push(`${label} uses profile ${record.capture.profile.name} instead of ${profile}.`);
    if (
      typeof record.environment.browser.version !== 'string' ||
      record.environment.browser.version.trim() === ''
    )
      findings.push(`${label} has no browser version.`);
    if (startSource !== null && p1Hash(record.source) !== p1Hash(startSource))
      findings.push(`${label} source differs from run start.`);
    if (endSource !== null && p1Hash(record.source) !== p1Hash(endSource))
      findings.push(`${label} source differs from run end.`);

    const compatibility = p1Hash(compatibleEnvironment(record));
    const previousCompatibility = browserCompatibility.get(browser);
    if (previousCompatibility === undefined) browserCompatibility.set(browser, compatibility);
    else if (previousCompatibility !== compatibility)
      findings.push(`${label} browser/device environment is incompatible with the ${browser} run.`);
  }

  if (new Set(group.map((record) => record.configurationSha256)).size > 1)
    findings.push('Repetitions have incompatible configuration hashes.');
  if (new Set(group.map((record) => record.environment.browser.version)).size > 1)
    findings.push('Repetitions have incompatible browser versions.');

  const structurallyValid =
    findings.length === 0 &&
    group.length === expectedCount &&
    group.every((record) => validRecords.has(record));
  const p95s: number[] = [];
  if (structurallyValid && profile === 'reference') {
    for (const record of group) {
      const summary = summarizeP1RunFrames(record.capture.frames, scenario, 'reference').summary;
      if (summary === null || !Number.isFinite(summary.p95))
        findings.push(`repetition ${record.repetition} has no finite raw p95.`);
      else p95s.push(summary.p95);
    }
  }
  const maxP95Ms = p95s.length === expectedCount ? Math.max(...p95s) : null;
  const ceilingMs = ceilings[scenario] ?? null;
  const A05: CriterionStatus =
    profile === 'reference' &&
    globalEligible &&
    findings.length === 0 &&
    group.every((record) => record.criteria.A05 === 'CANDIDATE')
      ? 'CANDIDATE'
      : 'UNVERIFIED';
  let A08: CriterionStatus = 'UNVERIFIED';
  if (profile === 'reference' && scenario === 'p1-single-transform-10k/v1') {
    A08 = 'NOT_APPLICABLE';
  } else if (profile === 'reference' && maxP95Ms !== null && ceilingMs !== null) {
    A08 = maxP95Ms <= ceilingMs ? (globalEligible ? 'CANDIDATE' : 'UNVERIFIED') : 'FAIL';
    if (A08 === 'FAIL')
      findings.push(`Raw maximum p95 ${maxP95Ms} ms exceeds the ${ceilingMs} ms A08 ceiling.`);
  }

  return Object.freeze({
    scenario,
    browser,
    profile,
    repetitions: Object.freeze(repetitions),
    maxP95Ms,
    ceilingMs,
    criteria: Object.freeze({ A05, A08 }),
    findings: Object.freeze(findings),
  });
}

export function aggregateP1Records(
  root: string,
  extraFindings: readonly string[] = [],
): P1Aggregate {
  const findings = [...extraFindings];
  const startMarker = readMarker(root, 'source-start.json', findings);
  const endMarker = readMarker(root, 'source-end.json', findings);
  const profile = profileFrom(startMarker, findings);
  if (endMarker?.profile !== undefined && endMarker.profile !== profile)
    findings.push('Run-end profile differs from run start.');
  const startSource = sourceFrom(startMarker, 'source-start.json', findings);
  const endSource = sourceFrom(endMarker, 'source-end.json', findings);
  if (startSource !== null && endSource !== null && p1Hash(startSource) !== p1Hash(endSource))
    findings.push('Source changed between run start and run end.');

  const { values, externalFindings } = readRecords(root, findings);
  const expectedKeys = new Set(
    P1_SCENARIOS.flatMap((scenario) => browsers.map((browser) => `${scenario}|${browser}`)),
  );
  for (const record of values) {
    const key = `${record.capture?.scenario}|${record.environment?.browser?.name}`;
    if (!expectedKeys.has(key)) findings.push(`Unexpected scenario/browser group ${key}.`);
  }
  const globalEligible = findings.length === 0;

  const browserCompatibility = new Map<string, string>();
  const groups =
    profile === null
      ? []
      : P1_SCENARIOS.flatMap((scenario) =>
          browsers.map((browser) =>
            aggregateGroup(
              values,
              scenario,
              browser,
              profile,
              startSource,
              endSource,
              browserCompatibility,
              externalFindings,
              globalEligible,
            ),
          ),
        );
  for (const group of groups)
    for (const finding of group.findings)
      findings.push(`${group.scenario}/${group.browser}: ${finding}`);

  const A05: CriterionStatus =
    profile === 'reference' &&
    globalEligible &&
    groups.length === 8 &&
    groups.every((group) => group.criteria.A05 === 'CANDIDATE')
      ? 'CANDIDATE'
      : 'UNVERIFIED';
  const applicableA08 = groups.filter((group) => group.criteria.A08 !== 'NOT_APPLICABLE');
  const A08: CriterionStatus =
    profile !== 'reference'
      ? 'UNVERIFIED'
      : applicableA08.some((group) => group.criteria.A08 === 'FAIL')
        ? 'FAIL'
        : applicableA08.length === 6 &&
            applicableA08.every((group) => group.criteria.A08 === 'CANDIDATE')
          ? 'CANDIDATE'
          : 'UNVERIFIED';

  return Object.freeze({
    profile,
    criteria: Object.freeze({ A05, A08 }),
    groups: Object.freeze(groups),
    findings: Object.freeze(findings),
  });
}

export function writeP1Aggregate(root: string, extraFindings: readonly string[] = []): void {
  let aggregate: P1Aggregate;
  try {
    aggregate = aggregateP1Records(root, extraFindings);
  } catch (error) {
    aggregate = Object.freeze({
      profile: null,
      criteria: Object.freeze({ A05: 'UNVERIFIED', A08: 'UNVERIFIED' }),
      groups: Object.freeze([]),
      findings: Object.freeze([
        ...extraFindings,
        `Aggregate validation failed unexpectedly: ${String(error)}`,
      ]),
    });
  }
  writeFileSync(
    path.join(root, 'aggregate.json'),
    `${JSON.stringify(
      {
        schema: 'p1-observed-run-aggregate/v1',
        createdAt: new Date().toISOString(),
        acceptance: { P1: 'UNVERIFIED', A09: 'UNVERIFIED', A10: 'UNVERIFIED' },
        ...aggregate,
      },
      null,
      2,
    )}\n`,
    { flag: 'wx' },
  );
  if (aggregate.findings.length > 0) throw new Error(aggregate.findings.join('\n'));
}
