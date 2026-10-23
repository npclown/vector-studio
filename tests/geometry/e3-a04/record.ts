// D9 E3 unit E3-U3: the A04 evidence record, its writer, its validator and its verdict
// (docs/plans/d9-e3-b4-precision-contract.md sections 7.3, 7.4, 9.2 (E3-A7, E3-A8, E3-A9) and 15.4).
//
// A04 is a deterministic correctness measurement, so the result is an evidence record under
// `docs/evidence/e3-a04/<UTC timestamp>-<run id>/` (`record.json` and `record.md`), not a
// benchmark result. The writer refuses to replace an existing artifact; the validator rebuilds
// every count, aggregate, the coverage table and the verdict from the case rows and refuses a
// record that does not reconcile with the corpus (E3-D10: no rejected case may be dropped).
//
// This module defines the format only. No real record is committed by unit E3-U3.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { type CaseObject, type CaseRow, TARGET_PX } from './harness.js';
import { unhex } from './corpus.js';

export const RECORD_SCHEMA = 'e3-a04-record/v1';

// ---------------------------------------------------------------------------------------------
// Rows

/** What a row needs from its corpus case for the aggregates (the case's own fields). */
export type RowMeta = Readonly<{
  index: number;
  stratum: string;
  transform: string;
  zoom: number;
  dpr: number;
  paint: 'fill' | 'stroke';
  placement: string;
  servedOffset: number;
}>;

export type RecordRow = RowMeta & CaseRow;

/** The pair label used by the case ids: `z0.01-d3`. */
export const pairLabel = (zoom: number, dpr: number): string => `z${zoom}-d${dpr}`;

export function metaOf(kase: CaseObject, index: number): RowMeta {
  const camera = kase.camera as { zoom: string; dpr: string };
  const paint = kase.paint as { kind: 'fill' | 'stroke' };
  return {
    index,
    stratum: String(kase.stratum),
    transform: String(kase.transform),
    zoom: unhex(camera.zoom),
    dpr: unhex(camera.dpr),
    paint: paint.kind,
    placement: String(kase.placement),
    servedOffset: Number(kase.servedOffset),
  };
}

export const TRANSFORMS = ['T0', 'T1', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7'] as const;
export const ZOOMS = [0.01, 1, 64] as const;
export const DPRS = [1, 2, 3] as const;
export const STATUSES = ['pass', 'fail', 'undecided', 'window-empty', 'rejected'] as const;

// ---------------------------------------------------------------------------------------------
// Aggregates (section 7.3)

export type GroupStats = {
  cases: number;
  measured: number;
  pass: number;
  fail: number;
  undecided: number;
  windowEmpty: number;
  rejected: number;
  rejectedBySource: Record<string, number>;
  rejectionRate: number;
  /** Maximum finite U and the case that attains it; unbounded counts the cases without one. */
  maxU: { value: number; id: string } | null;
  maxL: { value: number; id: string } | null;
  unbounded: number;
  p99U: number | null;
  p50U: number | null;
};

/** Nearest rank (docs/benchmarks/README.md): the ceil(p n / 100)-th smallest, 1-indexed. */
export function nearestRank(sorted: readonly number[], percent: number): number | null {
  if (sorted.length === 0) return null;
  const rank = Math.min(sorted.length, Math.max(1, Math.ceil((percent * sorted.length) / 100)));
  return sorted[rank - 1]!;
}

export function groupStats(rows: readonly RecordRow[]): GroupStats {
  const stats: GroupStats = {
    cases: rows.length,
    measured: 0,
    pass: 0,
    fail: 0,
    undecided: 0,
    windowEmpty: 0,
    rejected: 0,
    rejectedBySource: {},
    rejectionRate: 0,
    maxU: null,
    maxL: null,
    unbounded: 0,
    p99U: null,
    p50U: null,
  };
  const us: number[] = [];
  for (const r of rows) {
    if (r.status === 'pass') stats.pass += 1;
    else if (r.status === 'fail') stats.fail += 1;
    else if (r.status === 'undecided') stats.undecided += 1;
    else if (r.status === 'window-empty') stats.windowEmpty += 1;
    else {
      stats.rejected += 1;
      const source = r.rejection?.source ?? 'unknown';
      stats.rejectedBySource[source] = (stats.rejectedBySource[source] ?? 0) + 1;
    }
    if (r.status === 'rejected' || r.status === 'window-empty') continue;
    if (r.u === null) stats.unbounded += 1;
    else {
      us.push(r.u);
      if (stats.maxU === null || r.u > stats.maxU.value) stats.maxU = { value: r.u, id: r.id };
    }
    if (r.l !== null && (stats.maxL === null || r.l > stats.maxL.value))
      stats.maxL = { value: r.l, id: r.id };
  }
  stats.measured = stats.pass + stats.fail;
  stats.rejectionRate = rows.length === 0 ? 0 : stats.rejected / rows.length;
  us.sort((a, b) => a - b);
  stats.p99U = nearestRank(us, 99);
  stats.p50U = nearestRank(us, 50);
  return stats;
}

export type Aggregates = Readonly<{
  overall: GroupStats;
  byStratum: Record<string, GroupStats>;
  byTransform: Record<string, GroupStats>;
  byPair: Record<string, GroupStats>;
  byPaint: Record<string, GroupStats>;
}>;

function groupBy(
  rows: readonly RecordRow[],
  key: (r: RecordRow) => string,
): Record<string, GroupStats> {
  const map = new Map<string, RecordRow[]>();
  for (const r of rows) {
    const k = key(r);
    const list = map.get(k);
    if (list === undefined) map.set(k, [r]);
    else list.push(r);
  }
  const out: Record<string, GroupStats> = {};
  for (const k of [...map.keys()].sort()) out[k] = groupStats(map.get(k)!);
  return out;
}

export function buildAggregates(rows: readonly RecordRow[]): Aggregates {
  return {
    overall: groupStats(rows),
    byStratum: groupBy(rows, (r) => r.stratum),
    byTransform: groupBy(rows, (r) => r.transform),
    byPair: groupBy(rows, (r) => pairLabel(r.zoom, r.dpr)),
    byPaint: groupBy(rows, (r) => r.paint),
  };
}

// ---------------------------------------------------------------------------------------------
// Coverage (E3-A8): every declared cell (paint x transform x pair) needs a measured case

export type CoverageCell = Readonly<{
  paint: 'fill' | 'stroke';
  transform: string;
  pair: string;
  measured: number;
}>;

export type Coverage = Readonly<{
  cells: number;
  covered: number;
  /** The cells with no measured case: A04 is UNVERIFIED for each. */
  unverified: readonly CoverageCell[];
}>;

export function buildCoverage(rows: readonly RecordRow[]): Coverage {
  const measured = new Map<string, number>();
  for (const r of rows)
    if (r.status === 'pass' || r.status === 'fail') {
      const key = `${r.paint}|${r.transform}|${pairLabel(r.zoom, r.dpr)}`;
      measured.set(key, (measured.get(key) ?? 0) + 1);
    }
  const unverified: CoverageCell[] = [];
  let covered = 0;
  let cells = 0;
  for (const paint of ['fill', 'stroke'] as const)
    for (const transform of TRANSFORMS)
      for (const zoom of ZOOMS)
        for (const dpr of DPRS) {
          cells += 1;
          const pair = pairLabel(zoom, dpr);
          const count = measured.get(`${paint}|${transform}|${pair}`) ?? 0;
          if (count > 0) covered += 1;
          else unverified.push({ paint, transform, pair, measured: 0 });
        }
  return { cells, covered, unverified };
}

// ---------------------------------------------------------------------------------------------
// Controls (E3-A5)

export const REQUIRED_CONTROLS = [
  'E3-PC1',
  'E3-PC2',
  'E3-PC3',
  'E3-PC4',
  'E3-PC5',
  'E3-PC6',
  'E3-PC7',
  'E3-PC8',
  'E3-PC9',
  'E3-PC10',
  'E3-PC11',
  'E3-PC12',
  'E3-PC13',
  'E3-PC14',
] as const;

export type ControlOutcome = Readonly<{
  id: string;
  /** What the contract expects: FAIL for a positive control, PASS for a negative control. */
  expected: 'FAIL' | 'PASS' | 'INTERVAL' | 'GPU-CHECK-FAILS';
  observed: string;
  ok: boolean;
  detail: string;
}>;

// ---------------------------------------------------------------------------------------------
// Provenance (section 7.4)

export type Provenance = Readonly<{
  sourceCommit: string;
  dirty: boolean;
  contractSha256: string;
  wasmSha256: string | null;
  operations: Readonly<{ fill: string; stroke: string }>;
  corpus: Readonly<{ version: string; corpusSha256: string; cases: number }>;
  generatorSha256: string;
  oracleSha256: string;
  shaderIdentitySha256: string;
  carrier: 'K4';
  builderPlacement: string;
  node: string;
  os: string;
}>;

export const BUILDER_PLACEMENT = 'D8-interim TypeScript builders in renderer-core';

const sha256File = (file: string): string =>
  createHash('sha256').update(readFileSync(file)).digest('hex');

export function collectProvenance(
  root: string,
  input: Readonly<{
    wasmPath: string | null;
    operations: Provenance['operations'];
    corpus: Provenance['corpus'];
    generatorSha256: string;
    shaderIdentitySha256: string;
  }>,
): Provenance {
  const git = (...args: string[]): string =>
    execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  return {
    sourceCommit: git('rev-parse', 'HEAD'),
    dirty: git('status', '--porcelain').length > 0,
    contractSha256: sha256File(path.join(root, 'docs/plans/d9-e3-b4-precision-contract.md')),
    wasmSha256: input.wasmPath === null ? null : sha256File(input.wasmPath),
    operations: input.operations,
    corpus: input.corpus,
    generatorSha256: input.generatorSha256,
    oracleSha256: sha256File(path.join(root, 'packages/geometry-reference/src/a04-region.ts')),
    shaderIdentitySha256: input.shaderIdentitySha256,
    carrier: 'K4',
    builderPlacement: BUILDER_PLACEMENT,
    node: process.version,
    os: `${os.type()} ${os.release()} ${os.arch()}`,
  };
}

// ---------------------------------------------------------------------------------------------
// The record and the verdict (section 7.3)

export type GpuPart = Readonly<{
  /** The metadata of benchmarks/README accepted reference runs that applies to a readback. */
  adapter: string;
  browser: string;
  passed: boolean;
}>;

export type Verdict = Readonly<{
  /** `SAMPLE`: a stride run, which is evidence for the harness but gives no A04 verdict. */
  verdict: 'PASS' | 'FAIL' | 'UNVERIFIED' | 'SAMPLE';
  reasons: readonly string[];
}>;

export type EvidenceRecord = Readonly<{
  schema: typeof RECORD_SCHEMA;
  run: Readonly<{
    id: string;
    startedUtc: string;
    finishedUtc: string;
    stride: number;
    shards: number;
    /** Diagnostic wall time only (section 7.4); never a performance claim. */
    caseMilliseconds: number;
    wallMilliseconds: number;
  }>;
  provenance: Provenance;
  gpu: GpuPart | null;
  controls: readonly ControlOutcome[];
  aggregates: Aggregates;
  coverage: Coverage;
  /** Every rejected case with its code (section 6). */
  rejections: readonly Readonly<{ id: string; source: string; code: string }>[];
  verdict: Verdict;
  cases: readonly RecordRow[];
}>;

/** The case status rules of section 7.3 applied to a row's own numbers (E3-A9). */
export function rowConsistent(row: RecordRow): string | null {
  if (!(STATUSES as readonly string[]).includes(row.status)) return `unknown status ${row.status}`;
  if (row.status === 'pass' && !(row.u !== null && row.u <= TARGET_PX))
    return 'PASS without U <= 0.25';
  if (row.status === 'fail' && !(row.l !== null && row.l > TARGET_PX))
    return 'FAIL without L > 0.25';
  if (row.status === 'undecided' && row.reason === null) return 'UNDECIDED without a reason';
  if (row.status === 'rejected' && row.rejection === null) return 'rejected without a code';
  return null;
}

export function computeVerdict(
  rows: readonly RecordRow[],
  controls: readonly ControlOutcome[],
  gpu: GpuPart | null,
  stride: number,
  coverage: Coverage,
): Verdict {
  if (stride !== 1)
    return { verdict: 'SAMPLE', reasons: [`stride ${stride}: a sample run gives no A04 verdict`] };
  const reasons: string[] = [];
  const have = new Map(controls.map((c) => [c.id, c]));
  const missing = REQUIRED_CONTROLS.filter((id) => !have.has(id));
  if (missing.length > 0) reasons.push(`controls missing: ${missing.join(', ')}`);
  const bad = controls.filter((c) => !c.ok).map((c) => c.id);
  if (bad.length > 0) reasons.push(`controls not met: ${bad.join(', ')}`);
  // E3-A5: the controls must meet their expectations before any corpus result counts.
  if (missing.length > 0 || bad.length > 0) return { verdict: 'UNVERIFIED', reasons };
  const failed = rows.filter((r) => r.status === 'fail');
  if (failed.length > 0)
    return { verdict: 'FAIL', reasons: [`${failed.length} measured case(s) exceed 0.25 px`] };
  const undecided = rows.filter((r) => r.status === 'undecided').length;
  if (undecided > 0) reasons.push(`${undecided} UNDECIDED case(s)`);
  if (gpu === null) reasons.push('the GPU model check has not run (E3-A6)');
  else if (!gpu.passed) reasons.push('the GPU model check did not pass (E3-A6)');
  if (coverage.unverified.length > 0)
    reasons.push(`${coverage.unverified.length} declared cell(s) have no measured case (E3-A8)`);
  return reasons.length === 0
    ? { verdict: 'PASS', reasons: ['every measured case PASS; E3-A1 to E3-A9 hold'] }
    : { verdict: 'UNVERIFIED', reasons };
}

// ---------------------------------------------------------------------------------------------
// The corpus layout, for the reconciliation (E3-A7)

/** Generation order of the strata (section 13.2). */
export const STRATUM_ORDER = [
  'C1',
  'C2',
  'C3',
  'C4',
  'C5',
  'C9',
  'C10',
  'C11',
  'C12',
  'C6',
  'C7',
  'C8',
] as const;

export type CorpusLayout = Readonly<{
  cases: number;
  counts: Readonly<Record<string, number>>;
}>;

/** The stratum of each global index, from the per-stratum counts in generation order. */
export function stratumAt(layout: CorpusLayout, index: number): string | null {
  let start = 0;
  for (const stratum of STRATUM_ORDER) {
    const n = layout.counts[stratum] ?? 0;
    if (index < start + n) return stratum;
    start += n;
  }
  return null;
}

/** How many cases of each stratum a stride run attempts. */
export function expectedPerStratum(layout: CorpusLayout, stride: number): Record<string, number> {
  const out: Record<string, number> = {};
  let start = 0;
  for (const stratum of STRATUM_ORDER) {
    const n = layout.counts[stratum] ?? 0;
    // Indices start, start + 1, ..., start + n - 1 that are multiples of the stride.
    const first = Math.ceil(start / stride) * stride;
    out[stratum] = first >= start + n ? 0 : Math.floor((start + n - 1 - first) / stride) + 1;
    start += n;
  }
  return out;
}

export class RecordInvalid extends Error {
  public constructor(public readonly problems: readonly string[]) {
    super(`A04 evidence record is invalid:\n- ${problems.join('\n- ')}`);
    this.name = 'RecordInvalid';
  }
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/**
 * Validates a record against the corpus layout (E3-A7, E3-D10). Every problem is returned; the
 * list is empty when the record is acceptable. It rebuilds the aggregates, the coverage and the
 * verdict from the rows, so a record cannot claim a count that its rows do not support.
 */
export function validateRecord(
  record: EvidenceRecord,
  layout: CorpusLayout,
  options: Readonly<{ allowDirty?: boolean }> = {},
): string[] {
  const problems: string[] = [];
  if (record.schema !== RECORD_SCHEMA) problems.push(`schema is ${String(record.schema)}`);
  if (record.provenance.dirty && options.allowDirty !== true)
    problems.push('a dirty run is not accepted');
  if (record.provenance.corpus.cases !== layout.cases)
    problems.push(`corpus cases ${record.provenance.corpus.cases} != ${layout.cases}`);
  const stride = record.run.stride;
  if (!Number.isInteger(stride) || stride < 1) problems.push(`stride ${stride}`);

  // The rows must be exactly the attempted cases: every multiple of the stride, once.
  const expectedRows = Math.ceil(layout.cases / Math.max(1, stride));
  if (record.cases.length !== expectedRows)
    problems.push(`${record.cases.length} rows for ${expectedRows} attempted cases`);
  const seen = new Set<number>();
  const ids = new Set<string>();
  for (const row of record.cases) {
    if (seen.has(row.index)) problems.push(`index ${row.index} appears twice`);
    seen.add(row.index);
    if (ids.has(row.id)) problems.push(`id ${row.id} appears twice`);
    ids.add(row.id);
    if (row.index % stride !== 0 || row.index < 0 || row.index >= layout.cases)
      problems.push(`index ${row.index} is not an attempted case`);
    const stratum = stratumAt(layout, row.index);
    if (stratum !== row.stratum)
      problems.push(`index ${row.index} is stratum ${String(stratum)}, not ${row.stratum}`);
    const bad = rowConsistent(row);
    if (bad !== null) problems.push(`${row.id}: ${bad}`);
  }
  const perStratum = expectedPerStratum(layout, stride);
  const counted: Record<string, number> = {};
  for (const row of record.cases) counted[row.stratum] = (counted[row.stratum] ?? 0) + 1;
  for (const stratum of STRATUM_ORDER)
    if ((counted[stratum] ?? 0) !== perStratum[stratum])
      problems.push(
        `stratum ${stratum}: ${counted[stratum] ?? 0} rows, ${perStratum[stratum]} attempted`,
      );

  // The record's derived parts must equal what the rows give.
  const aggregates = buildAggregates(record.cases);
  if (!same(record.aggregates, aggregates)) problems.push('aggregates do not match the rows');
  const o = record.aggregates.overall;
  if (o.cases !== o.pass + o.fail + o.undecided + o.windowEmpty + o.rejected)
    problems.push('overall counts do not sum to the cases');
  const rejections = record.cases
    .filter((r) => r.status === 'rejected')
    .map((r) => ({ id: r.id, source: r.rejection?.source ?? '', code: r.rejection?.code ?? '' }));
  if (!same(record.rejections, rejections))
    problems.push('the rejection list does not match the rejected rows');
  if (!same(record.coverage, buildCoverage(record.cases)))
    problems.push('coverage does not match the rows');
  const verdict = computeVerdict(
    record.cases,
    record.controls,
    record.gpu,
    stride,
    buildCoverage(record.cases),
  );
  if (!same(record.verdict, verdict)) problems.push('the verdict does not follow section 7.3');
  return problems;
}

// ---------------------------------------------------------------------------------------------
// Building and writing

export function buildRecord(
  input: Readonly<{
    run: EvidenceRecord['run'];
    provenance: Provenance;
    gpu: GpuPart | null;
    controls: readonly ControlOutcome[];
    rows: readonly RecordRow[];
  }>,
): EvidenceRecord {
  const rows = [...input.rows].sort((a, b) => a.index - b.index);
  const coverage = buildCoverage(rows);
  return {
    schema: RECORD_SCHEMA,
    run: input.run,
    provenance: input.provenance,
    gpu: input.gpu,
    controls: input.controls,
    aggregates: buildAggregates(rows),
    coverage,
    rejections: rows
      .filter((r) => r.status === 'rejected')
      .map((r) => ({ id: r.id, source: r.rejection?.source ?? '', code: r.rejection?.code ?? '' })),
    verdict: computeVerdict(rows, input.controls, input.gpu, input.run.stride, coverage),
    cases: rows,
  };
}

/** `record.json`: everything pretty-printed except the case rows, which take one line each. */
export function stringifyRecord(record: EvidenceRecord): string {
  const { cases, ...rest } = record;
  const head = JSON.stringify(rest, null, 2);
  const lines = cases.map((row) => `    ${JSON.stringify(row)}`);
  return `${head.slice(0, head.length - 2)},\n  "cases": [\n${lines.join(',\n')}\n  ]\n}\n`;
}

export function utcStamp(date: Date): string {
  return date.toISOString().replace(/[-:]/gu, '').replace(/\.\d+Z$/u, 'Z');
}

/**
 * Writes `<root>/<UTC stamp>-<run id>/record.json` and `record.md`. The directory must not exist
 * and neither file is ever replaced (`wx`); the record is validated first and a record that does
 * not reconcile is never written.
 */
export function writeEvidenceRecord(
  rootDir: string,
  record: EvidenceRecord,
  layout: CorpusLayout,
  now: Date = new Date(),
  options: Readonly<{ allowDirty?: boolean }> = {},
): string {
  const problems = validateRecord(record, layout, options);
  if (problems.length > 0) throw new RecordInvalid(problems);
  if (!/^[A-Za-z0-9._-]+$/u.test(record.run.id)) throw new RecordInvalid(['unsafe run id']);
  const dir = path.join(rootDir, `${utcStamp(now)}-${record.run.id}`);
  if (existsSync(dir)) throw new Error(`refusing to replace the existing record ${dir}`);
  mkdirSync(rootDir, { recursive: true });
  mkdirSync(dir);
  writeFileSync(path.join(dir, 'record.json'), stringifyRecord(record), { flag: 'wx' });
  writeFileSync(path.join(dir, 'record.md'), renderMarkdown(record), { flag: 'wx' });
  return dir;
}

const fmt = (x: number | null, digits = 4): string => (x === null ? 'n/a' : x.toFixed(digits));

export function renderMarkdown(record: EvidenceRecord): string {
  const o = record.aggregates.overall;
  const lines: string[] = [];
  lines.push('# A04 evidence record (D9 E3, `a04-corpus/v1`)', '');
  lines.push(
    `Run \`${record.run.id}\`, stride ${record.run.stride}. Verdict as measured: **${record.verdict.verdict}**.`,
    '',
  );
  for (const reason of record.verdict.reasons) lines.push(`- ${reason}`);
  lines.push('', '## Provenance', '');
  for (const [key, value] of Object.entries(record.provenance))
    lines.push(`- ${key}: \`${JSON.stringify(value)}\``);
  lines.push('', '## Controls', '', '| Control | Expected | Observed | OK | Detail |', '| --- | --- | --- | --- | --- |');
  for (const c of record.controls)
    lines.push(`| ${c.id} | ${c.expected} | ${c.observed} | ${c.ok ? 'yes' : 'NO'} | ${c.detail} |`);
  lines.push('', '## Counts', '');
  lines.push(
    `Cases ${o.cases}: measured ${o.measured} (PASS ${o.pass}, FAIL ${o.fail}), UNDECIDED ${o.undecided}, window-empty ${o.windowEmpty}, rejected ${o.rejected}.`,
    '',
    `Maximum U: ${o.maxU === null ? 'n/a' : `${fmt(o.maxU.value)} at ${o.maxU.id}`}. p99 ${fmt(o.p99U)}, p50 ${fmt(o.p50U)}. p99 is reported, never gated.`,
    '',
    '| Group | Cases | Measured | FAIL | UNDECIDED | window-empty | Rejected | Max U | p99 U |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
  );
  const table = (label: string, groups: Record<string, GroupStats>): void => {
    for (const [name, g] of Object.entries(groups))
      lines.push(
        `| ${label} ${name} | ${g.cases} | ${g.measured} | ${g.fail} | ${g.undecided} | ${g.windowEmpty} | ${g.rejected} | ${fmt(g.maxU?.value ?? null)} | ${fmt(g.p99U)} |`,
      );
  };
  table('stratum', record.aggregates.byStratum);
  table('transform', record.aggregates.byTransform);
  table('pair', record.aggregates.byPair);
  table('paint', record.aggregates.byPaint);
  lines.push('', '## Coverage (E3-A8)', '');
  lines.push(`${record.coverage.covered} of ${record.coverage.cells} declared cells have a measured case.`);
  for (const cell of record.coverage.unverified)
    lines.push(`- UNVERIFIED: ${cell.paint} ${cell.transform} ${cell.pair}`);
  lines.push('', '## Rejections (routed to A01 to A03, section 6)', '');
  lines.push(`${record.rejections.length} rejected case(s); the full list is in record.json.`);
  lines.push(
    '',
    'Acceptance is the Primary\'s, after an independent evidence review. Wall times in record.json are diagnostics only.',
    '',
  );
  return lines.join('\n');
}
