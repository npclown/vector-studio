// D9 E3 unit E3-U3: the A04 evidence record (docs/plans/d9-e3-b4-precision-contract.md,
// sections 7.2 to 7.4 and 9.2, executable form in section 15.7): aggregates, the coverage
// condition E3-A8, the verdict of section 7.3, the validator of E3-A7 and the Markdown view.
// The verdict written here is the measured disposition; acceptance is the Primary's after an
// independent evidence review.
import type { CaseStatus, HarnessRow } from './harness.js';

export const A04_RECORD_SCHEMA = 'e3-a04-record/v1';
export const A04_TARGET_PX = 0.25;
export const DECLARED_TRANSFORMS = ['T0', 'T1', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7'] as const;
export const DECLARED_PAIRS = ['0.01', '1', '64'].flatMap((z) =>
  ['1', '2', '3'].map((d) => `z${z}-d${d}`),
);

export type ControlOutcome = Readonly<{
  id: string;
  expected: string;
  observed: string;
  ok: boolean;
  detail?: Readonly<Record<string, unknown>>;
}>;

export type GpuCheck = Readonly<{
  /** E3-A6: the readback model check passed in every listed browser. */
  passed: boolean;
  browsers: readonly Readonly<Record<string, unknown>>[];
  record: string;
}>;

export type Selection = Readonly<{
  /** Every corpus case, or a strided sample (never acceptable as A04 evidence). */
  stride: number;
  shards: number;
  corpusCases: number;
}>;

export type Provenance = Readonly<Record<string, unknown>> &
  Readonly<{ commit: string; dirty: boolean; corpusSha256: string }>;

export type Aggregate = {
  cases: number;
  measured: number;
  pass: number;
  fail: number;
  undecided: number;
  windowEmpty: number;
  rejected: number;
  maxU: number | null;
  maxUCase: string | null;
  p99U: number | null;
  p50U: number | null;
};

export type Verdict = 'PASS' | 'FAIL' | 'UNVERIFIED';

export type A04Record = Readonly<{
  schema: typeof A04_RECORD_SCHEMA;
  provenance: Provenance;
  selection: Selection;
  gpu: GpuCheck | null;
  controls: readonly ControlOutcome[];
  rows: readonly HarnessRow[];
  aggregates: Readonly<Record<string, Readonly<Record<string, Aggregate>>>>;
  rejections: Readonly<Record<string, number>>;
  uncoveredCells: readonly string[];
  maxIntervalWidth: number | null;
  verdict: Verdict;
  verdictReasons: readonly string[];
}>;

/** One browser's output of tests/gpu/e3-a04-readback.spec.ts (`e3-a04-gpu-check/v1`). */
export type GpuBrowserCheck = Readonly<{
  schema: string;
  passed: boolean;
  browser: Readonly<{ project: string } & Record<string, unknown>>;
  shaderSha256: string;
  wasmSha256: string;
}> &
  Readonly<Record<string, unknown>>;

/**
 * E3-A6 from the per-browser files: it passes only when Chrome and Edge both passed, on this
 * shader source and this release WASM.
 */
export function combineGpuChecks(
  checks: readonly GpuBrowserCheck[],
  expected: Readonly<{ shaderSha256: string; wasmSha256: string }>,
  record: string,
): GpuCheck {
  const projects = new Set(checks.map((c) => c.browser.project));
  const passed =
    projects.has('chrome') &&
    projects.has('edge') &&
    checks.every(
      (c) =>
        c.schema === 'e3-a04-gpu-check/v1' &&
        c.passed &&
        (c.browser.adapter as Readonly<{ software?: boolean }> | undefined)?.software !== true &&
        c.shaderSha256 === expected.shaderSha256 &&
        c.wasmSha256 === expected.wasmSha256,
    );
  return { passed, browsers: checks.map((c) => c.browser), record };
}

const MEASURED: ReadonlySet<CaseStatus> = new Set(['pass', 'fail', 'undecided']);

/** Nearest rank (docs/benchmarks/README.md, samples and aggregation). */
export function nearestRank(sorted: readonly number[], p: number): number | null {
  if (sorted.length === 0) return null;
  return sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)]!;
}

function aggregate(rows: readonly HarnessRow[]): Aggregate {
  const a: Aggregate = {
    cases: rows.length,
    measured: 0,
    pass: 0,
    fail: 0,
    undecided: 0,
    windowEmpty: 0,
    rejected: 0,
    maxU: null,
    maxUCase: null,
    p99U: null,
    p50U: null,
  };
  const us: number[] = [];
  for (const r of rows) {
    if (MEASURED.has(r.status)) a.measured += 1;
    if (r.status === 'pass') a.pass += 1;
    else if (r.status === 'fail') a.fail += 1;
    else if (r.status === 'undecided') a.undecided += 1;
    else if (r.status === 'window-empty') a.windowEmpty += 1;
    else a.rejected += 1;
    if (r.u !== null && MEASURED.has(r.status)) {
      us.push(r.u);
      if (a.maxU === null || r.u > a.maxU) {
        a.maxU = r.u;
        a.maxUCase = r.id;
      }
    }
  }
  us.sort((x, y) => x - y);
  a.p99U = nearestRank(us, 0.99);
  a.p50U = nearestRank(us, 0.5);
  return a;
}

function groupBy(rows: readonly HarnessRow[], key: (r: HarnessRow) => string) {
  const groups = new Map<string, HarnessRow[]>();
  for (const r of rows) {
    const k = key(r);
    const list = groups.get(k) ?? [];
    list.push(r);
    groups.set(k, list);
  }
  return Object.fromEntries(
    [...groups].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, v]) => [k, aggregate(v)]),
  );
}

/** Section 7.3's statistic: per stratum, transform, pair, paint and overall. */
export function aggregates(rows: readonly HarnessRow[]): A04Record['aggregates'] {
  return {
    overall: { all: aggregate(rows) },
    stratum: groupBy(rows, (r) => r.stratum ?? '-'),
    transform: groupBy(rows, (r) => r.transform ?? '-'),
    pair: groupBy(rows, (r) => r.pair),
    paint: groupBy(rows, (r) => r.paint),
  };
}

/** E3-A8: paint × declared transform × pair cells with no measured case. */
export function uncoveredCells(rows: readonly HarnessRow[]): string[] {
  const covered = new Set<string>();
  for (const r of rows)
    if (MEASURED.has(r.status)) covered.add(`${r.paint}/${r.transform}/${r.pair}`);
  const missing: string[] = [];
  for (const paint of ['fill', 'stroke'])
    for (const t of DECLARED_TRANSFORMS)
      for (const pair of DECLARED_PAIRS)
        if (!covered.has(`${paint}/${t}/${pair}`)) missing.push(`${paint}/${t}/${pair}`);
  return missing;
}

/** Section 7.3's A04 verdict, with the reasons that keep it from PASS. */
export function verdictOf(
  input: Pick<A04Record, 'rows' | 'controls' | 'gpu' | 'selection' | 'provenance'>,
): Readonly<{ verdict: Verdict; reasons: string[] }> {
  const reasons: string[] = [];
  if (input.rows.some((r) => r.status === 'fail'))
    return { verdict: 'FAIL', reasons: ['a measured case is FAIL'] };
  const undecided = input.rows.filter((r) => r.status === 'undecided').length;
  if (undecided > 0) reasons.push(`${undecided} UNDECIDED case(s)`);
  const badControls = input.controls.filter((c) => !c.ok).map((c) => c.id);
  if (badControls.length > 0) reasons.push(`controls not met: ${badControls.join(', ')}`);
  if (input.controls.length === 0) reasons.push('no control outcomes');
  if (input.gpu === null) reasons.push('no GPU model check (E3-A6)');
  else if (!input.gpu.passed) reasons.push('the GPU model check failed (E3-A6)');
  const missing = uncoveredCells(input.rows).length;
  if (missing > 0) reasons.push(`${missing} uncovered cell(s) (E3-A8)`);
  if (input.selection.stride !== 1)
    reasons.push(`a strided sample (stride ${input.selection.stride})`);
  if (input.rows.length !== input.selection.corpusCases)
    reasons.push(`${input.rows.length} of ${input.selection.corpusCases} corpus cases`);
  if (input.provenance.dirty) reasons.push('a dirty worktree');
  return { verdict: reasons.length === 0 ? 'PASS' : 'UNVERIFIED', reasons };
}

function rejectionCounts(rows: readonly HarnessRow[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const r of rows)
    if (r.status === 'rejected') counts[r.code ?? '-'] = (counts[r.code ?? '-'] ?? 0) + 1;
  return Object.fromEntries(Object.entries(counts).sort());
}

export function buildRecord(
  input: Pick<A04Record, 'provenance' | 'selection' | 'gpu' | 'controls' | 'rows'>,
): A04Record {
  const rows = [...input.rows].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
  let width: number | null = null;
  for (const r of rows)
    if (r.eLo !== null && r.eHi !== null && Number.isFinite(r.eHi))
      width = Math.max(width ?? 0, r.eHi - r.eLo);
  const { verdict, reasons } = verdictOf({ ...input, rows });
  return {
    schema: A04_RECORD_SCHEMA,
    provenance: input.provenance,
    selection: input.selection,
    gpu: input.gpu,
    controls: input.controls,
    rows,
    aggregates: aggregates(rows),
    rejections: rejectionCounts(rows),
    uncoveredCells: uncoveredCells(rows),
    maxIntervalWidth: width,
    verdict,
    verdictReasons: reasons,
  };
}

/**
 * E3-A7: the validator. It reconciles the rows with the corpus ids (by index), recomputes the
 * aggregates, the coverage and the verdict, and checks each row's status against its bounds.
 * `corpusIds` is the corpus's id list in generation order. Returns the problems found.
 */
export function validateRecord(record: A04Record, corpusIds: readonly string[]): string[] {
  const problems: string[] = [];
  if (record.schema !== A04_RECORD_SCHEMA) problems.push(`schema ${String(record.schema)}`);
  if (record.selection.corpusCases !== corpusIds.length)
    problems.push(
      `selection.corpusCases ${record.selection.corpusCases} ≠ corpus ${corpusIds.length}`,
    );
  const stride = record.selection.stride;
  const expected = corpusIds.filter((_, i) => i % stride === 0).length;
  if (record.rows.length !== expected)
    problems.push(
      `rows ${record.rows.length} ≠ ${expected} selected corpus cases (stride ${stride})`,
    );
  const seen = new Set<number>();
  for (const r of record.rows) {
    if (r.index === null || !Number.isInteger(r.index)) {
      problems.push(`row ${r.id} has no index`);
      continue;
    }
    if (seen.has(r.index)) problems.push(`index ${r.index} repeated`);
    seen.add(r.index);
    if (r.index % stride !== 0) problems.push(`index ${r.index} outside the stride`);
    if (corpusIds[r.index] !== r.id)
      problems.push(`index ${r.index}: id ${r.id} ≠ corpus ${corpusIds[r.index]}`);
    if (r.status === 'pass' && !(r.u !== null && r.u <= A04_TARGET_PX))
      problems.push(`${r.id}: PASS without U ≤ 0.25`);
    if (r.status === 'fail' && !(r.l !== null && r.l > A04_TARGET_PX))
      problems.push(`${r.id}: FAIL without L > 0.25`);
    if (r.status === 'rejected' && r.code === null)
      problems.push(`${r.id}: rejected without a code`);
    if (r.status === 'undecided' && r.reason === null)
      problems.push(`${r.id}: UNDECIDED without a reason`);
  }
  const overall = record.aggregates.overall?.all;
  if (overall === undefined) problems.push('no overall aggregate');
  else {
    const sum = overall.measured + overall.windowEmpty + overall.rejected;
    if (sum !== record.rows.length) problems.push(`counts ${sum} ≠ rows ${record.rows.length}`);
    if (overall.pass + overall.fail + overall.undecided !== overall.measured)
      problems.push('measured ≠ pass + fail + undecided');
  }
  if (JSON.stringify(aggregates(record.rows)) !== JSON.stringify(record.aggregates))
    problems.push('aggregates differ from the rows');
  if (JSON.stringify(uncoveredCells(record.rows)) !== JSON.stringify(record.uncoveredCells))
    problems.push('coverage differs from the rows');
  const v = verdictOf(record);
  if (v.verdict !== record.verdict) problems.push(`verdict ${record.verdict} ≠ ${v.verdict}`);
  return problems;
}

const fmt = (v: number | null) => (v === null ? '—' : v.toPrecision(6));

/** The record's Markdown view (record.md). */
export function renderRecordMarkdown(record: A04Record, problems: readonly string[]): string {
  const p = record.provenance;
  const o = record.aggregates.overall!.all!;
  const lines = [
    '# E3 A04 evidence record',
    '',
    `Schema \`${record.schema}\`. Measured disposition: **${record.verdict}**. Acceptance is the Primary's after an independent evidence review (contract section 7.4).`,
    '',
    '## Provenance',
    '',
    ...Object.entries(p).map(
      ([k, v]) => `- ${k}: \`${typeof v === 'string' ? v : JSON.stringify(v)}\``,
    ),
    `- selection: stride ${record.selection.stride}, ${record.selection.shards} shard(s), corpus ${record.selection.corpusCases} cases`,
    `- GPU model check: ${record.gpu === null ? 'none attached' : record.gpu.passed ? `passed (${record.gpu.record})` : `failed (${record.gpu.record})`}`,
    '',
    '## Verdict',
    '',
    ...(record.verdictReasons.length === 0
      ? ['- All section 7.3 conditions hold.']
      : record.verdictReasons.map((r) => `- ${r}`)),
    `- Validator: ${problems.length === 0 ? 'no problems' : problems.join('; ')}`,
    '',
    '## Overall',
    '',
    `| Cases | Measured | PASS | FAIL | UNDECIDED | window-empty | Rejected | max U (px) | p99 U | p50 U |`,
    `| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |`,
    `| ${o.cases} | ${o.measured} | ${o.pass} | ${o.fail} | ${o.undecided} | ${o.windowEmpty} | ${o.rejected} | ${fmt(o.maxU)} | ${fmt(o.p99U)} | ${fmt(o.p50U)} |`,
    '',
    `Max U case: \`${o.maxUCase ?? '—'}\`. Max oracle interval width: ${fmt(record.maxIntervalWidth)} px.`,
    '',
  ];
  for (const group of ['stratum', 'transform', 'pair', 'paint'] as const) {
    lines.push(
      `## Per ${group}`,
      '',
      '| Key | Measured | PASS | FAIL | UNDECIDED | window-empty | Rejected | max U | p99 U |',
      '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
    );
    for (const [k, a] of Object.entries(record.aggregates[group] ?? {}))
      lines.push(
        `| ${k} | ${a.measured} | ${a.pass} | ${a.fail} | ${a.undecided} | ${a.windowEmpty} | ${a.rejected} | ${fmt(a.maxU)} | ${fmt(a.p99U)} |`,
      );
    lines.push('');
  }
  lines.push(
    '## Controls',
    '',
    '| Control | Expected | Observed | Met |',
    '| --- | --- | --- | --- |',
  );
  for (const c of record.controls)
    lines.push(`| ${c.id} | ${c.expected} | ${c.observed} | ${c.ok ? 'yes' : '**no**'} |`);
  lines.push('', '## Rejections', '');
  const rejections = Object.entries(record.rejections);
  lines.push(
    ...(rejections.length === 0 ? ['None.'] : rejections.map(([k, v]) => `- \`${k}\`: ${v}`)),
  );
  lines.push(
    '',
    `## Coverage (E3-A8)`,
    '',
    record.uncoveredCells.length === 0
      ? 'Every declared cell has a measured case.'
      : `Uncovered cells (${record.uncoveredCells.length}): ${record.uncoveredCells.map((c) => `\`${c}\``).join(', ')}`,
    '',
  );
  lines.push(
    'Rasterizer snapping and the fixed-function viewport precision are an explicit residual (E3-Q7 (a)), not a term of U. Cracks at T-junctions are reported per case and judged by A01 (E3-Q10 (b)).',
    '',
  );
  return `${lines.join('\n')}\n`;
}
