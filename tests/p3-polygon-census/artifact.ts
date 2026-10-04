import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fsyncSync,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  statSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import path from 'node:path';
import type {
  CanonicalEdge,
  Classification,
  Edge,
  Pair,
  Relation,
  RelationCounts,
} from './types.js';

const RELATION_ORDER = [
  'DISJOINT',
  'PROPER_CROSSING',
  'ENDPOINT_TOUCH',
  'T_JUNCTION',
  'COLLINEAR_POINT',
  'COINCIDENT_SAME',
  'COINCIDENT_REVERSED',
  'COLLINEAR_OVERLAP',
] as const satisfies readonly Relation[];

export const SCHEMA = 'p3-polygon-relations/v1' as const;
export const FAILURE_STAGES = [
  'CLI',
  'SOURCE',
  'INPUT',
  'OUTPUT',
  'ABI',
  'CLASSIFY',
  'JOURNAL',
  'WORKER',
  'SUMMARY',
  'AUDIT',
] as const;
export type FailureStage = (typeof FAILURE_STAGES)[number];
export type Mode = 'SMOKE' | 'FULL';

export const HISTORICAL_RECORDS = {
  head: '9508a6615f6b6e941aee26802a49eb9ca1b9dbd0',
  manifestSha256: 'd443f5e5e18d5b60c11cb546cbaa15e36da5abec1bc8f58cd1df4f27b5507f0b',
  invocationSha256: '460b63483f0377832674bd9296400940d2c259c003e504df5938228cbd0763d6',
  censusSha256: '869c93b782d833cb6e28503bf4e80ee65155edfc6e68e5fe06c38af8d34cf803',
  rowsSha256: 'e9536c9b8c51aa6bc5132692c8bb506b367da8e010ffbabd80e800b873a2d634',
  auditSha256: 'ba298dabe8306c233b105a7d25b29323b10962c23dd9e3d0d7e31070e081dd80',
  inputBytes: 1_684_000,
  outputBytes: 38_612_072,
} as const;

export const LIMITS = {
  rawEmitted: 4096,
  edges: 4097,
  pairsPerPath: 8_390_656,
  paths: 1000,
  inputFrameBytes: 4096,
  outputFrameBytes: 262_144,
  inputBytes: 4_194_304,
  outputBytes: 134_217_728,
  rowBytes: 65_536,
  journalBytes: 67_108_864,
} as const;

const SOURCE_PATHS = [
  'packages/geometry-reference/src',
  'packages/geometry-wasm/src',
  'tests/geometry/differential',
  'tests/geometry/cubic-boundary',
  'tests/p3-census',
  'tests/p3-polygon-census',
  'tests/geometry/rounded-fill/exact.ts',
  'tests/geometry-benchmark/workload.ts',
  'tooling/run-p3-polygon-census.mjs',
  'tooling/run-p3-polygon-census.d.mts',
  'vitest.p3-polygon-census.config.ts',
  'package.json',
  'pnpm-lock.yaml',
  'tsconfig.json',
  'tsconfig.base.json',
  'eslint.config.mjs',
  '.node-version',
  'docs/plans/p3-polygon-relation-census-contract.md',
] as const;

export type ExpandedWitness = Readonly<{
  pair: Pair;
  first: CanonicalEdge;
  second: CanonicalEdge;
}>;
export type ExpandedWitnesses = Record<Relation, ExpandedWitness | null>;
export type CensusRow = Readonly<{
  index: number;
  nodeId: string;
  inputFrameSha256: string | null;
  outputFrameSha256: string | null;
  rawEmitted: number;
  omittedZero: number;
  retainedEmitted: number;
  closure: 0 | 1;
  normalizedEdges: number;
  normalizedEdgeSha256: string;
  classification: Classification;
  witnesses: ExpandedWitnesses;
}>;
export type LocatedMaximum = Readonly<{ value: number; index: number }>;
export type CensusSummary = Readonly<{
  rows: number;
  rawEmitted: number;
  omittedZero: number;
  retainedEmitted: number;
  closure: number;
  normalizedEdges: number;
  pairs: number;
  aabbRejected: number;
  exactTested: number;
  counts: RelationCounts;
  adjacent: RelationCounts;
  nonadjacent: RelationCounts;
  maxima: Readonly<{
    normalizedEdges: LocatedMaximum;
    pairs: LocatedMaximum;
    exactTested: LocatedMaximum;
    peakCandidateRecords: LocatedMaximum;
  }>;
}>;

export function sha256(bytes: ArrayBufferView | string): string {
  const input =
    typeof bytes === 'string'
      ? bytes
      : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return createHash('sha256').update(input).digest('hex');
}

function normalizedSource(file: string): string {
  let text = readFileSync(file, 'utf8');
  if (text.startsWith('\ufeff')) text = text.slice(1);
  return text.replaceAll('\r\n', '\n').replaceAll('\r', '\n');
}

export function captureAnalysis(root: string): Readonly<{
  head: string;
  dirty: boolean;
  manifest: readonly Readonly<{ path: string; sha256: string }>[];
  manifestSha256: string;
}> {
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  const realRoot = realpathSync(root);
  const files = git('ls-files', '--cached', '--others', '--exclude-standard', '--', ...SOURCE_PATHS)
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((file) => file.replaceAll('\\', '/'))
    .sort();
  if (files.length === 0) throw new Error('analysis source manifest is empty');
  const manifest = files.map((relative) => {
    const file = path.join(root, relative);
    if (lstatSync(file).isSymbolicLink())
      throw new Error(`analysis source is a symlink: ${relative}`);
    const real = realpathSync(file);
    const inside = path.relative(realRoot, real);
    if (inside.startsWith('..') || path.isAbsolute(inside))
      throw new Error(`analysis source escapes repository: ${relative}`);
    return { path: relative, sha256: sha256(Buffer.from(normalizedSource(file), 'utf8')) };
  });
  return {
    head: git('rev-parse', 'HEAD'),
    dirty: git('status', '--porcelain').length > 0,
    manifest,
    manifestSha256: sha256(Buffer.from(JSON.stringify(manifest), 'utf8')),
  };
}

export function assertAnalysisStable(
  start: Readonly<{ head: unknown; dirty: unknown; manifestSha256: unknown }>,
  end: Readonly<{ head: unknown; dirty: unknown; manifestSha256: unknown }>,
  mode: Mode,
): void {
  if (
    start.head !== end.head ||
    start.dirty !== end.dirty ||
    start.manifestSha256 !== end.manifestSha256
  )
    throw new Error('analysis source changed during execution');
  if (mode === 'FULL' && start.dirty !== false)
    throw new Error('FULL analysis source must remain clean');
}

export function policy(mode: Mode): Record<string, unknown> {
  return {
    role: mode === 'FULL' ? 'HISTORICAL_POLYGON_ANALYSIS' : 'ANALYTIC_SMOKE',
    scenario: mode === 'FULL' ? 'p2-batch/v1' : 'p3-polygon-smoke/v1',
    seed: mode === 'FULL' ? 0x12345678 : null,
    paths: mode === 'FULL' ? 1000 : 4,
    classes: [...RELATION_ORDER],
    digestVersion: 1,
    limits: { ...LIMITS },
    timeoutsMs: { phase: 900_000, child: 960_000 },
    excludedStages: [
      'CURRENT_KERNEL',
      'POSITION_PROOF',
      'CURVED_TOPOLOGY',
      'MESH',
      'GPU',
      'PERFORMANCE',
    ],
  };
}

function fsyncedExclusive(file: string, bytes: string | Buffer): void {
  const fd = openSync(file, 'wx');
  try {
    writeFileSync(fd, bytes);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

export function writeJsonExclusive(file: string, value: unknown): void {
  fsyncedExclusive(file, `${JSON.stringify(value, null, 2)}\n`);
}

export function createInvocation(
  root: string,
  outputDirectory: string,
  mode: Mode,
): Record<string, unknown> {
  const start = captureAnalysis(root);
  const value = {
    schema: SCHEMA,
    mode,
    metadata: {
      historical: null,
      analysis: {
        head: start.head,
        dirty: start.dirty,
        nodeVersion: process.version,
        manifest: start.manifest,
        manifestStartSha256: start.manifestSha256,
        manifestEndSha256: null,
      },
    },
    policy: policy(mode),
  };
  writeJsonExclusive(path.join(outputDirectory, 'invocation.json'), value);
  return value;
}

function scanJournal(file: string): Readonly<{
  bytes: number;
  count: number;
  sha256: string;
  prefixBytes: number;
  prefixSha256: string;
}> {
  const size = statSync(file).size;
  if (size > LIMITS.journalBytes) throw new Error('journal exceeds 64 MiB');
  const all = createHash('sha256');
  const prefix = createHash('sha256');
  const fd = openSync(file, 'r');
  const chunk = Buffer.alloc(64 * 1024);
  let offset = 0;
  let prefixBytes = 0;
  let count = 0;
  try {
    while (offset < size) {
      const length = readSync(fd, chunk, 0, Math.min(chunk.length, size - offset), offset);
      if (length === 0) throw new Error('journal ended before its recorded size');
      const current = chunk.subarray(0, length);
      all.update(current);
      for (let index = 0; index < length; index += 1) {
        if (current[index] === 0x0a) {
          prefixBytes = offset + index + 1;
          count += 1;
        }
      }
      offset += length;
    }
  } finally {
    closeSync(fd);
  }
  const prefixFd = openSync(file, 'r');
  offset = 0;
  try {
    while (offset < prefixBytes) {
      const length = readSync(
        prefixFd,
        chunk,
        0,
        Math.min(chunk.length, prefixBytes - offset),
        offset,
      );
      if (length === 0) throw new Error('journal prefix ended unexpectedly');
      prefix.update(chunk.subarray(0, length));
      offset += length;
    }
  } finally {
    closeSync(prefixFd);
  }
  return {
    bytes: size,
    count,
    sha256: all.digest('hex'),
    prefixBytes,
    prefixSha256: prefix.digest('hex'),
  };
}

export function describeJournal(outputDirectory: string): Record<string, unknown> {
  const file = path.join(outputDirectory, 'rows.ndjson');
  if (!existsSync(file))
    return { path: 'rows.ndjson', sha256: sha256(Buffer.alloc(0)), bytes: 0, count: 0 };
  const scanned = scanJournal(file);
  const result: Record<string, unknown> = {
    path: 'rows.ndjson',
    sha256: scanned.sha256,
    bytes: scanned.bytes,
    count: scanned.count,
  };
  if (scanned.prefixBytes !== scanned.bytes)
    result.completePrefix = {
      bytes: scanned.prefixBytes,
      count: scanned.count,
      sha256: scanned.prefixSha256,
    };
  return result;
}

const journalIdentities = new Map<string, Readonly<{ dev: number; ino: number; size: number }>>();

export function appendJournalRow(outputDirectory: string, row: unknown): void {
  const bytes = Buffer.from(`${JSON.stringify(row)}\n`, 'utf8');
  if (bytes.length > LIMITS.rowBytes) throw new Error('polygon journal row exceeds 64 KiB');
  const file = path.resolve(outputDirectory, 'rows.ndjson');
  const current = existsSync(file) ? statSync(file).size : 0;
  if (current + bytes.length > LIMITS.journalBytes)
    throw new Error('polygon journal exceeds 64 MiB');
  const known = journalIdentities.get(file);
  if (known === undefined && existsSync(file))
    throw new Error('polygon journal already exists before exclusive creation');
  const fd = openSync(file, known === undefined ? 'wx' : 'r+');
  try {
    const identity = fstatSync(fd);
    if (known === undefined) {
      if (identity.size !== 0) throw new Error('new polygon journal is not empty');
    } else if (identity.dev !== known.dev || identity.ino !== known.ino) {
      throw new Error('polygon journal file identity changed during execution');
    } else if (identity.size !== known.size || identity.size !== current) {
      throw new Error('polygon journal length changed during execution');
    }
    const written = writeSync(fd, bytes, 0, bytes.length, current);
    if (written !== bytes.length) throw new Error('polygon journal row write was incomplete');
    fsyncSync(fd);
    journalIdentities.set(file, {
      dev: identity.dev,
      ino: identity.ino,
      size: current + bytes.length,
    });
  } finally {
    closeSync(fd);
  }
}

export function readJournalRows(outputDirectory: string): unknown[] {
  const file = path.join(outputDirectory, 'rows.ndjson');
  if (!existsSync(file)) return [];
  const descriptor = scanJournal(file);
  if (descriptor.prefixBytes !== descriptor.bytes) throw new Error('journal has a partial tail');
  const text = readFileSync(file, 'utf8');
  if (text.length === 0) return [];
  return text
    .slice(0, -1)
    .split('\n')
    .map((line) => {
      if (Buffer.byteLength(line, 'utf8') + 1 > LIMITS.rowBytes)
        throw new Error('polygon journal row exceeds 64 KiB');
      return JSON.parse(line) as unknown;
    });
}

function safeAdd(left: number, right: number, label: string): number {
  const value = left + right;
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} is not a safe count`);
  return value;
}

function zeroCounts(): RelationCounts {
  return Object.fromEntries(RELATION_ORDER.map((relation) => [relation, 0])) as RelationCounts;
}

export function expandWitnesses(
  edges: readonly Edge[],
  classification: Classification,
  canonicalize: (edge: Edge) => CanonicalEdge,
): ExpandedWitnesses {
  return Object.fromEntries(
    RELATION_ORDER.map((relation) => {
      const pair = classification.first[relation];
      return [
        relation,
        pair === null
          ? null
          : {
              pair,
              first: canonicalize(edges[pair[0]]!),
              second: canonicalize(edges[pair[1]]!),
            },
      ];
    }),
  ) as ExpandedWitnesses;
}

export function summarizeRows(rows: readonly CensusRow[]): CensusSummary {
  if (rows.length === 0) throw new Error('cannot summarize an empty polygon census');
  const totals = {
    rawEmitted: 0,
    omittedZero: 0,
    retainedEmitted: 0,
    closure: 0,
    normalizedEdges: 0,
    pairs: 0,
    aabbRejected: 0,
    exactTested: 0,
  };
  const counts = zeroCounts();
  const adjacent = zeroCounts();
  const nonadjacent = zeroCounts();
  const maxima = {
    normalizedEdges: { value: -1, index: 0 },
    pairs: { value: -1, index: 0 },
    exactTested: { value: -1, index: 0 },
    peakCandidateRecords: { value: -1, index: 0 },
  };
  rows.forEach((row, index) => {
    if (row.index !== index) throw new Error('polygon rows are not in source order');
    for (const key of Object.keys(totals) as (keyof typeof totals)[]) {
      const value =
        key === 'pairs' || key === 'aabbRejected' || key === 'exactTested'
          ? row.classification[key]
          : row[key];
      totals[key] = safeAdd(totals[key], value, `${key} total`);
    }
    for (const relation of RELATION_ORDER) {
      counts[relation] = safeAdd(
        counts[relation],
        row.classification.counts[relation],
        `${relation} total`,
      );
      adjacent[relation] = safeAdd(
        adjacent[relation],
        row.classification.adjacent[relation],
        `${relation} adjacent`,
      );
      nonadjacent[relation] = safeAdd(
        nonadjacent[relation],
        row.classification.nonadjacent[relation],
        `${relation} nonadjacent`,
      );
    }
    const values = {
      normalizedEdges: row.normalizedEdges,
      pairs: row.classification.pairs,
      exactTested: row.classification.exactTested,
      peakCandidateRecords: row.classification.peakCandidateRecords,
    };
    for (const key of Object.keys(maxima) as (keyof typeof maxima)[])
      if (values[key] > maxima[key].value) maxima[key] = { value: values[key], index };
  });
  return { rows: rows.length, ...totals, counts, adjacent, nonadjacent, maxima };
}

export function finishMetadata(
  root: string,
  invocation: Record<string, unknown>,
  historical: unknown,
): Record<string, unknown> {
  const metadata = invocation.metadata as { analysis: Record<string, unknown> };
  const end = captureAnalysis(root);
  return {
    historical,
    analysis: { ...metadata.analysis, manifestEndSha256: end.manifestSha256 },
  };
}

export function writeIncomplete(
  root: string,
  outputDirectory: string,
  stage: FailureStage,
  message: string,
  index: number | null = null,
): void {
  if (!FAILURE_STAGES.includes(stage)) throw new Error('unknown polygon failure stage');
  if (!message) throw new Error('polygon failure message is empty');
  if (index !== null && (!Number.isSafeInteger(index) || index < 0))
    throw new Error('polygon failure index is invalid');
  const terminal = path.join(outputDirectory, 'report.json');
  if (existsSync(terminal)) return;
  const invocation = JSON.parse(
    readFileSync(path.join(outputDirectory, 'invocation.json'), 'utf8'),
  ) as Record<string, unknown>;
  let metadata = invocation.metadata;
  let terminalMessage = message;
  try {
    metadata = finishMetadata(root, invocation, null);
  } catch (error) {
    terminalMessage = `${message}; analysis end capture failed: ${String(error)}`;
  }
  writeJsonExclusive(terminal, {
    schema: SCHEMA,
    mode: invocation.mode,
    completion: 'INCOMPLETE',
    metadata,
    policy: invocation.policy,
    rows: describeJournal(outputDirectory),
    summary: null,
    failure: { stage, message: terminalMessage, index },
  });
}

export function readExact(
  fd: number,
  length: number,
  label = 'framed input',
): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(length);
  let offset = 0;
  while (offset < length) {
    const count = readSync(fd, bytes, offset, length - offset, null);
    if (count === 0) throw new Error(`truncated ${label}`);
    offset += count;
  }
  return bytes;
}

export function assertExactKeys(
  value: unknown,
  label: string,
  keys: readonly string[],
): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new Error(`${label} must be an object`);
  const record = value as Record<string, unknown>;
  if (JSON.stringify(Object.keys(record).sort()) !== JSON.stringify([...keys].sort()))
    throw new Error(`${label} keys mismatch`);
  return record;
}

function nonnegative(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
    throw new Error(`${label} must be a nonnegative safe integer`);
  return value;
}

function digest(value: unknown, label: string, nullable = false): void {
  if (nullable && value === null) return;
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/u.test(value))
    throw new Error(`${label} must be a SHA-256 digest${nullable ? ' or null' : ''}`);
}

function assertRelationMap(value: unknown, label: string): RelationCounts {
  const record = assertExactKeys(value, label, RELATION_ORDER);
  for (const relation of RELATION_ORDER) nonnegative(record[relation], `${label}.${relation}`);
  return record as RelationCounts;
}

/** Strictly validates the externally persisted row schema and its internal arithmetic. */
export function assertCensusRow(value: unknown, mode: Mode): asserts value is CensusRow {
  const row = assertExactKeys(value, 'polygon row', [
    'index',
    'nodeId',
    'inputFrameSha256',
    'outputFrameSha256',
    'rawEmitted',
    'omittedZero',
    'retainedEmitted',
    'closure',
    'normalizedEdges',
    'normalizedEdgeSha256',
    'classification',
    'witnesses',
  ]);
  nonnegative(row.index, 'row.index');
  if (typeof row.nodeId !== 'string' || row.nodeId.length === 0)
    throw new Error('row.nodeId is invalid');
  digest(row.inputFrameSha256, 'row.inputFrameSha256', mode === 'SMOKE');
  digest(row.outputFrameSha256, 'row.outputFrameSha256', mode === 'SMOKE');
  if (mode === 'SMOKE' && (row.inputFrameSha256 !== null || row.outputFrameSha256 !== null))
    throw new Error('SMOKE frame hashes must be null');
  const raw = nonnegative(row.rawEmitted, 'row.rawEmitted');
  const omitted = nonnegative(row.omittedZero, 'row.omittedZero');
  const retained = nonnegative(row.retainedEmitted, 'row.retainedEmitted');
  const closure = nonnegative(row.closure, 'row.closure');
  const edges = nonnegative(row.normalizedEdges, 'row.normalizedEdges');
  if (raw > LIMITS.rawEmitted || edges > LIMITS.edges || closure > 1)
    throw new Error('row normalization exceeds frozen bounds');
  if (raw !== omitted + retained || edges !== retained + closure)
    throw new Error('row normalization arithmetic mismatch');
  digest(row.normalizedEdgeSha256, 'row.normalizedEdgeSha256');
  const classification = assertExactKeys(row.classification, 'row.classification', [
    'edges',
    'pairs',
    'aabbRejected',
    'exactTested',
    'counts',
    'adjacent',
    'nonadjacent',
    'first',
    'contactSha256',
    'peakCandidateRecords',
  ]);
  const classifiedEdges = nonnegative(classification.edges, 'classification.edges');
  const pairs = nonnegative(classification.pairs, 'classification.pairs');
  const rejected = nonnegative(classification.aabbRejected, 'classification.aabbRejected');
  const exact = nonnegative(classification.exactTested, 'classification.exactTested');
  const peak = nonnegative(
    classification.peakCandidateRecords,
    'classification.peakCandidateRecords',
  );
  if (
    classifiedEdges !== edges ||
    pairs !== (edges * (edges - 1)) / 2 ||
    pairs > LIMITS.pairsPerPath ||
    rejected + exact !== pairs ||
    peak > edges
  )
    throw new Error('classification arithmetic mismatch');
  const counts = assertRelationMap(classification.counts, 'classification.counts');
  const adjacent = assertRelationMap(classification.adjacent, 'classification.adjacent');
  const nonadjacent = assertRelationMap(classification.nonadjacent, 'classification.nonadjacent');
  const first = assertExactKeys(classification.first, 'classification.first', RELATION_ORDER);
  const witnesses = assertExactKeys(row.witnesses, 'row.witnesses', RELATION_ORDER);
  let countTotal = 0;
  for (const relation of RELATION_ORDER) {
    countTotal = safeAdd(countTotal, counts[relation], 'classification count total');
    if (adjacent[relation] + nonadjacent[relation] !== counts[relation])
      throw new Error(`classification ${relation} adjacency arithmetic mismatch`);
    const pair = first[relation];
    if ((counts[relation] === 0) !== (pair === null))
      throw new Error(`classification ${relation} witness/count mismatch`);
    if (pair !== null) {
      if (
        !Array.isArray(pair) ||
        pair.length !== 2 ||
        !pair.every((entry) => Number.isSafeInteger(entry) && entry >= 0) ||
        pair[0] >= pair[1] ||
        pair[1] >= edges
      )
        throw new Error(`classification ${relation} witness pair invalid`);
      const expanded = assertExactKeys(witnesses[relation], `row.witnesses.${relation}`, [
        'pair',
        'first',
        'second',
      ]);
      if (JSON.stringify(expanded.pair) !== JSON.stringify(pair))
        throw new Error(`row.witnesses.${relation} pair mismatch`);
    } else if (witnesses[relation] !== null)
      throw new Error(`row.witnesses.${relation} must be null`);
  }
  if (countTotal !== pairs) throw new Error('classification relation total mismatch');
  digest(classification.contactSha256, 'classification.contactSha256');
}
