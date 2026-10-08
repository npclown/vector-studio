// P3 B0 aggregates, fits, estimates, checks and verdict, as frozen by
// docs/plans/p3-b0-feasibility-benchmark-contract.md sections 3-5. The runner stores
// analyze(record) in the record; validateRecord recomputes it from the raw samples.
// Erasable TypeScript only, with type-only local imports, so Node can load it directly.
import { createHash } from 'node:crypto';
import type { CellSpec, ScenarioConfig } from './corpus.js';

export interface AdmissionPath {
  readonly status: string;
  readonly flatCommands?: number;
  readonly vertices?: number;
  readonly triangles?: number;
  readonly rounded: boolean;
  readonly transverse: boolean;
  readonly allocations: number;
}
export interface AdmissionCell {
  readonly cell: string;
  readonly paths: readonly AdmissionPath[];
}
export interface TimedCell {
  readonly cell: string;
  readonly workspaceNs: number;
  readonly batchAllocations: number;
  readonly batchNs: readonly number[];
  readonly pathNs: readonly number[];
  readonly checksums: readonly string[];
}
export interface DecisionOutput {
  readonly kind: 'decision';
  readonly repetition: number;
  readonly clockQuantumNs: number;
  readonly workspace: { readonly inlineBytes: number; readonly allocatedBytes: number };
  readonly admission: readonly AdmissionCell[];
  readonly order: readonly string[];
  readonly cells: readonly TimedCell[];
  readonly linearity: {
    readonly cell: string;
    readonly batch10Ns: readonly number[];
    readonly checksums10: readonly string[];
    readonly batch100Ns: readonly number[];
    readonly checksums100: readonly string[];
  } | null;
}
export interface DiagnosticOutput {
  readonly kind: 'diagnostic';
  readonly clockQuantumNs: number;
  readonly observations: readonly AdmissionCell[];
  readonly stages: readonly {
    readonly cell: string;
    readonly s1Ns: readonly number[];
    readonly s2Ns: readonly number[];
    readonly s3Ns: readonly number[];
    readonly counts: readonly { routine: string; instance: string; calls: number }[];
  }[];
  readonly replay: {
    readonly cell: string;
    readonly loops: number;
    readonly calls: number;
    readonly baselineNs: readonly number[];
    readonly routines: readonly {
      routine: string;
      instance: string;
      captured: number;
      meansNs: readonly number[];
    }[];
  };
}
export interface B0Record {
  readonly schemaVersion: 1;
  readonly scenario: {
    readonly id: string;
    readonly version: number;
    readonly profile: 'functional' | 'reference';
    readonly config: ScenarioConfig;
    readonly configHash: string;
  };
  readonly run: Record<string, unknown>;
  readonly environment: Record<string, unknown>;
  readonly builds: Record<string, unknown>;
  readonly corpus: { readonly sha256: string; readonly bytes: number };
  readonly repetitions: readonly DecisionOutput[];
  readonly diagnostic: DiagnosticOutput | null;
  /** Repetition or diagnostic processes that failed; their data is absent. */
  readonly failures?: readonly { stage: string; error: string; log: string }[];
  readonly analysis?: unknown;
}

const DECISION_PATHS = 10;
const LINEARITY_PATHS = 100;

/** Canonical JSON: sorted keys, no whitespace, shortest round-trip numbers. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`;
  }
  if (typeof value === 'number' && !Number.isFinite(value)) throw new Error('nonfinite number');
  return JSON.stringify(value);
}

export function configHash(config: unknown): string {
  return createHash('sha256').update(canonicalJson(config)).digest('hex');
}

export interface Summary {
  readonly n: number;
  readonly median: number;
  readonly p95: number;
  readonly p99: number;
  readonly min: number;
  readonly max: number;
}

/** Nearest rank: index ceil(p * n) - 1 of the ascending samples. */
export function nearestRank(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) throw new Error('empty sample');
  return sorted[Math.ceil(p * sorted.length) - 1]!;
}

export function summarize(samples: readonly number[]): Summary {
  for (const value of samples)
    if (!Number.isFinite(value) || value < 0) throw new Error('invalid duration sample');
  const sorted = [...samples].sort((left, right) => left - right);
  return {
    n: sorted.length,
    median: nearestRank(sorted, 0.5),
    p95: nearestRank(sorted, 0.95),
    p99: nearestRank(sorted, 0.99),
    min: sorted[0]!,
    max: sorted[sorted.length - 1]!,
  };
}

export type Classification = 'ADMITTED' | 'CAP-BOUND' | 'NOT-ADMITTED';

/** Classifies a cell from its first `paths` admission results. */
export function classify(
  cell: AdmissionCell,
  capCodes: readonly string[],
  paths = cell.paths.length,
): {
  classification: Classification;
  firstFailure: { path: number; code: string } | null;
} {
  const index = cell.paths.slice(0, paths).findIndex((path) => path.status !== 'OK');
  if (index < 0) return { classification: 'ADMITTED', firstFailure: null };
  const code = cell.paths[index]!.status;
  return {
    classification: capCodes.includes(code) ? 'CAP-BOUND' : 'NOT-ADMITTED',
    firstFailure: { path: index, code },
  };
}

export interface Fit {
  readonly series: string;
  readonly repetition: number;
  readonly kind: 'median' | 'p95';
  readonly points: readonly { leaves: number; ns: number }[];
  readonly slope: number | null;
  readonly intercept: number | null;
  readonly upper: number | null;
  readonly guard: number | null;
  readonly predicted: number | null;
  readonly estimateNs: number | null;
  readonly predictionFactor: number | null;
}

export function leaves(cell: CellSpec): number {
  return cell.contours * cell.cubicsPerContour * cell.lambda;
}

/** Log-log OLS with an upper prediction bound and the curvature guard at L*. */
export function fitSeries(
  series: string,
  repetition: number,
  kind: 'median' | 'p95',
  points: readonly { leaves: number; ns: number }[],
  targetLeaves: number,
  tTable: Readonly<Record<number, number>>,
): Fit {
  const sorted = [...points].sort((left, right) => left.leaves - right.leaves);
  const empty = {
    series,
    repetition,
    kind,
    points: sorted,
    slope: null,
    intercept: null,
    upper: null,
    guard: null,
    predicted: null,
    estimateNs: null,
    predictionFactor: null,
  };
  const n = sorted.length;
  const quantile = tTable[n - 2];
  if (n < 3 || quantile === undefined || sorted.some((point) => !(point.ns > 0))) return empty;
  const xs = sorted.map((point) => Math.log(point.leaves));
  const ys = sorted.map((point) => Math.log(point.ns));
  const meanX = xs.reduce((sum, x) => sum + x, 0) / n;
  const meanY = ys.reduce((sum, y) => sum + y, 0) / n;
  let sxx = 0;
  let sxy = 0;
  for (let index = 0; index < n; index += 1) {
    sxx += (xs[index]! - meanX) ** 2;
    sxy += (xs[index]! - meanX) * (ys[index]! - meanY);
  }
  const slope = sxy / sxx;
  const intercept = meanY - slope * meanX;
  let sse = 0;
  for (let index = 0; index < n; index += 1)
    sse += (ys[index]! - (intercept + slope * xs[index]!)) ** 2;
  const residual = Math.sqrt(sse / (n - 2));
  const xStar = Math.log(targetLeaves);
  const predicted = intercept + slope * xStar;
  const upper = predicted + quantile * residual * Math.sqrt(1 + 1 / n + (xStar - meanX) ** 2 / sxx);
  // Guard: the largest-L point and the point whose L is nearest half of it (ties: smaller L).
  const largest = sorted[n - 1]!;
  let half = sorted[0]!;
  for (const point of sorted.slice(0, -1)) {
    if (Math.abs(point.leaves - largest.leaves / 2) < Math.abs(half.leaves - largest.leaves / 2))
      half = point;
  }
  const xl = Math.log(largest.leaves);
  const yl = Math.log(largest.ns);
  const guard = yl + ((yl - Math.log(half.ns)) / (xl - Math.log(half.leaves))) * (xStar - xl);
  return {
    ...empty,
    slope,
    intercept,
    upper,
    guard,
    predicted,
    estimateNs: Math.exp(Math.max(upper, guard)),
    predictionFactor: Math.exp(upper - predicted),
  };
}

function linear(points: readonly { x: number; y: number }[], at: number): number | null {
  const n = points.length;
  if (n < 2) return null;
  const meanX = points.reduce((sum, point) => sum + point.x, 0) / n;
  const meanY = points.reduce((sum, point) => sum + point.y, 0) / n;
  let sxx = 0;
  let sxy = 0;
  for (const point of points) {
    sxx += (point.x - meanX) ** 2;
    sxy += (point.x - meanX) * (point.y - meanY);
  }
  return meanY + (sxy / sxx) * (at - meanX);
}

function median(values: readonly number[]): number {
  return summarize(values).median;
}

interface Check {
  readonly id: string;
  readonly pass: boolean;
  readonly detail: string;
}

const REQUIRED_ENVIRONMENT = [
  'observedAt',
  'os',
  'cpu',
  'logicalCores',
  'memoryBytes',
  'timezone',
  'power',
  'backgroundLoad',
];

export function analyze(record: B0Record) {
  const config = record.scenario.config;
  const decision = config.decision;
  const cells = config.cells.filter((cell) => cell.role === 'decision');
  const specOf = new Map(config.cells.map((cell) => [cell.id, cell]));
  const reps = [...record.repetitions].sort((left, right) => left.repetition - right.repetition);
  const checks: Check[] = [];
  const check = (id: string, pass: boolean, detail: string) => checks.push({ id, pass, detail });

  // Admission, from repetition 0, and its agreement across repetitions.
  const admission = cells.map((spec) => {
    const entry = reps[0]?.admission.find((item) => item.cell === spec.id);
    // The decision admission is paths 0-9; P4/s=16's paths 10-99 serve linearity only.
    const decisionPaths = config.admission.decisionPaths;
    const result = entry
      ? classify(entry, config.admission.capCodes, decisionPaths)
      : { classification: 'NOT-ADMITTED' as Classification, firstFailure: null };
    const okPaths =
      result.classification === 'ADMITTED' && entry ? entry.paths.slice(0, decisionPaths) : [];
    const meanMeshBytes =
      okPaths.length === 0
        ? null
        : okPaths.reduce((sum, path) => sum + 16 * path.vertices! + 12 * path.triangles!, 0) /
          okPaths.length;
    return { cell: spec.id, series: spec.series, leaves: leaves(spec), ...result, meanMeshBytes };
  });
  const admitted = new Set(
    admission.filter((item) => item.classification === 'ADMITTED').map((item) => item.cell),
  );
  const firstAdmission = canonicalJson(reps[0]?.admission ?? []);
  check(
    '5b-admission-and-topology-identical',
    reps.every(
      (rep) =>
        canonicalJson(rep.admission.map(withoutAllocations)) ===
        canonicalJson((reps[0]?.admission ?? []).map(withoutAllocations)),
    ),
    `${reps.length} repetitions compared; first admission hash ${configHash(firstAdmission).slice(0, 12)}`,
  );

  // Per-cell aggregates per repetition.
  const perCell = cells.map((spec) => {
    const perRepetition = reps.flatMap((rep) => {
      const timed = rep.cells.find((cell) => cell.cell === spec.id);
      if (!timed) return [];
      const batch = summarize(timed.batchNs.map((ns) => ns / DECISION_PATHS));
      const path = summarize(timed.pathNs);
      const unverified = timed.batchNs.some(
        (ns) => ns < decision.quantumMultiple * rep.clockQuantumNs,
      );
      return [
        {
          repetition: rep.repetition,
          unverified,
          batchAllocations: timed.batchAllocations,
          workspaceNs: timed.workspaceNs,
          batch,
          path,
        },
      ];
    });
    return { cell: spec.id, series: spec.series, leaves: leaves(spec), perRepetition };
  });

  // Fits for the primary and observational series.
  const fits: Fit[] = [];
  const fitSeriesNames = [...decision.primarySeries, 'K2'];
  for (const series of fitSeriesNames) {
    const seriesCells = cells.filter((spec) => spec.series === series);
    const targetLeaves = decision.workloadCubics * seriesCells[0]!.lambda;
    for (const rep of reps) {
      for (const kind of ['median', 'p95'] as const) {
        const points = seriesCells.flatMap((spec) => {
          if (!admitted.has(spec.id)) return [];
          const entry = perCell
            .find((cell) => cell.cell === spec.id)
            ?.perRepetition.find((item) => item.repetition === rep.repetition);
          if (!entry) return [];
          return [
            { leaves: leaves(spec), ns: kind === 'median' ? entry.batch.median : entry.path.p95 },
          ];
        });
        fits.push(
          fitSeries(series, rep.repetition, kind, points, targetLeaves, decision.tQuantile95),
        );
      }
    }
  }

  // Validity checks 1-8.
  for (const series of decision.primarySeries) {
    const seriesCells = cells.filter((spec) => spec.series === series);
    const largest = seriesCells.reduce((left, right) =>
      leaves(right) > leaves(left) ? right : left,
    );
    const count = seriesCells.filter((spec) => admitted.has(spec.id)).length;
    check(
      `1-admitted-${series}`,
      count >= decision.minimumPrimaryCells && admitted.has(largest.id),
      `${count} admitted; largest ${largest.id} ${admitted.has(largest.id) ? 'admitted' : 'missing'}`,
    );
  }
  const primaryFits = fits.filter((fit) =>
    (decision.primarySeries as readonly string[]).includes(fit.series),
  );
  check(
    '2-prediction-factor',
    primaryFits.length > 0 &&
      primaryFits.every(
        (fit) =>
          fit.predictionFactor !== null && fit.predictionFactor <= decision.predictionFactorLimit,
      ),
    `max factor ${Math.max(...primaryFits.map((fit) => fit.predictionFactor ?? Infinity)).toFixed(3)}`,
  );
  const unverified = perCell
    .filter((cell) => (decision.primarySeries as readonly string[]).includes(cell.series))
    .filter((cell) => cell.perRepetition.some((item) => item.unverified))
    .map((cell) => cell.cell);
  check('3-no-unverified-primary-cell', unverified.length === 0, unverified.join(', ') || 'none');

  const linearity = reps.map((rep) => {
    if (!rep.linearity) return { repetition: rep.repetition, ratio: null, pass: false };
    const small = median(rep.linearity.batch10Ns) / DECISION_PATHS;
    const large = median(rep.linearity.batch100Ns) / LINEARITY_PATHS;
    const ratio = large / small;
    return {
      repetition: rep.repetition,
      perPath10Ns: small,
      perPath100Ns: large,
      ratio,
      pass: ratio <= decision.linearityLimit,
    };
  });
  check(
    '4-linearity',
    linearity.length > 0 && linearity.every((item) => item.pass),
    linearity.map((item) => `r${item.repetition}=${item.ratio?.toFixed(3) ?? 'missing'}`).join(' '),
  );

  const checksumIssues: string[] = [];
  for (const spec of cells) {
    const sums = new Set<string>();
    for (const rep of reps) {
      const timed = rep.cells.find((cell) => cell.cell === spec.id);
      timed?.checksums.forEach((sum) => sums.add(sum));
      if (rep.linearity && rep.linearity.cell === spec.id)
        rep.linearity.checksums10.forEach((sum) => sums.add(sum));
    }
    if (sums.size > 1) checksumIssues.push(spec.id);
  }
  const large = new Set(reps.flatMap((rep) => rep.linearity?.checksums100 ?? []));
  if (large.size > 1) checksumIssues.push('linearity-100');
  check(
    '5-checksums-identical',
    checksumIssues.length === 0,
    checksumIssues.join(', ') || 'all equal',
  );

  const flatIssues: string[] = [];
  for (const rep of reps) {
    for (const entry of rep.admission) {
      const spec = specOf.get(entry.cell);
      if (!spec) continue;
      const expected = leaves(spec) + 2 * spec.contours;
      if (entry.paths.some((path) => path.status === 'OK' && path.flatCommands !== expected))
        flatIssues.push(`r${rep.repetition}:${entry.cell}`);
    }
  }
  check(
    '6-flat-commands',
    flatIssues.length === 0,
    flatIssues.join(', ') || `L + 2C on every path`,
  );

  const expectedReps = config.sampling.repetitions;
  check(
    '7-repetitions-complete',
    reps.length === expectedReps && reps.every((rep, index) => rep.repetition === index),
    `${reps.length} of ${expectedReps}`,
  );
  const missingRun = [
    ['run.commit', record.run.commit],
    ['run.sourceManifest', record.run.sourceManifest],
    ['run.runner', record.run.runner],
    ['builds.toolchain', record.builds.toolchain],
    ['builds.decision', record.builds.decision],
    ['corpus.sha256', record.corpus.sha256],
    ...(config.sampling.diagnostic ? [['builds.diagnostic', record.builds.diagnostic]] : []),
  ]
    .filter(([, value]) => value === undefined || value === null || value === '')
    .map(([name]) => name as string);
  const missingEnvironment = REQUIRED_ENVIRONMENT.filter(
    (key) => record.environment[key] === undefined || record.environment[key] === null,
  );
  const missing = [...missingEnvironment, ...missingRun];
  check('8-metadata-complete', missing.length === 0, missing.join(', ') || 'complete');

  // Estimates.
  const estimateOf = (kind: 'median' | 'p95') =>
    primaryFits
      .filter((fit) => fit.kind === kind)
      .reduce<number | null>(
        (best, fit) =>
          fit.estimateNs === null
            ? best
            : best === null
              ? fit.estimateNs
              : Math.max(best, fit.estimateNs),
        null,
      );
  const perPathNs = estimateOf('median');
  const p95Ns = estimateOf('p95');
  const meshByPath = decision.primarySeries.map((series) => {
    const seriesCells = admission.filter(
      (item) =>
        item.series === series && item.classification === 'ADMITTED' && item.meanMeshBytes !== null,
    );
    const lambda = cells.find((spec) => spec.series === series)!.lambda;
    return linear(
      seriesCells.map((item) => ({ x: item.leaves, y: item.meanMeshBytes! })),
      decision.workloadCubics * lambda,
    );
  });
  const meshPerPath = meshByPath.some((value) => value === null)
    ? null
    : Math.max(...(meshByPath as number[]));
  const estimates =
    perPathNs === null || p95Ns === null || meshPerPath === null
      ? null
      : {
          perPathNs,
          initialMs: (decision.workloadPaths * perPathNs * decision.wasmFactor) / 1e6,
          editMs: (p95Ns * decision.wasmFactor) / 1e6,
          meshBytes: decision.workloadPaths * meshPerPath,
        };

  // Contour sensitivity: K2 and K4 against P4 at equal total cubics.
  const cellMedian = (id: string) => {
    const entry = perCell.find((cell) => cell.cell === id);
    return entry && entry.perRepetition.length > 0
      ? median(entry.perRepetition.map((item) => item.batch.median))
      : null;
  };
  const contour = [6, 8, 12, 16].map((cubics) => {
    const base = cellMedian(`P4/s=${cubics}`);
    const ratio = (id: string) => {
      const value = cellMedian(id);
      return base === null || value === null || !admitted.has(id) ? null : value / base;
    };
    return {
      cubics,
      k2: cubics % 2 === 0 ? ratio(`K2/s=${cubics / 2}`) : null,
      k4: cubics % 4 === 0 ? ratio(`K4/s=${cubics / 4}`) : null,
    };
  });

  const h1 = record.diagnostic
    ? analyzeH1(record.diagnostic, cells, admitted, cellMedian, config)
    : null;
  const observations = record.diagnostic
    ? record.diagnostic.observations.map((entry) => {
        const codes: Record<string, number> = {};
        for (const path of entry.paths) codes[path.status] = (codes[path.status] ?? 0) + 1;
        return { cell: entry.cell, ok: codes.OK ?? 0, total: entry.paths.length, codes };
      })
    : null;

  let verdict: 'NONE' | 'FEASIBLE' | 'INFEASIBLE' | 'INCONCLUSIVE';
  if (record.scenario.profile !== 'reference') verdict = 'NONE';
  else if (!checks.every((item) => item.pass) || estimates === null) verdict = 'INCONCLUSIVE';
  else
    verdict =
      estimates.initialMs <= decision.budgets.initialMs &&
      estimates.editMs <= decision.budgets.editMs &&
      estimates.meshBytes <= decision.budgets.meshBytes
        ? 'FEASIBLE'
        : 'INFEASIBLE';

  // Informational: the harness allocates nothing in a timed batch (contract section 3).
  const allocationFreeBatches = perCell.every((cell) =>
    cell.perRepetition.every((item) => item.batchAllocations === 0),
  );

  return {
    admission,
    perCell,
    fits,
    linearity,
    contour,
    estimates,
    checks,
    h1,
    observations,
    allocationFreeBatches,
    failures: record.failures ?? [],
    verdict,
  };
}

function withoutAllocations(cell: AdmissionCell) {
  return {
    cell: cell.cell,
    paths: cell.paths.map((path) => ({ ...path, allocations: 0 })),
  };
}

function analyzeH1(
  diagnostic: DiagnosticOutput,
  cells: readonly CellSpec[],
  admitted: ReadonlySet<string>,
  decisionMedian: (id: string) => number | null,
  config: ScenarioConfig,
) {
  const baseline = median(diagnostic.replay.baselineNs);
  // Contract section 4 item 3: the unit cost is the median of the per-call means.
  // The guard-only baseline is reported separately and does not enter the verdict.
  const unit = new Map(
    diagnostic.replay.routines.map((routine) => [
      `${routine.routine}|${routine.instance}`,
      median(routine.meansNs),
    ]),
  );
  return config.decision.primarySeries.map((series) => {
    const candidates = cells.filter((spec) => spec.series === series && admitted.has(spec.id));
    if (candidates.length === 0) return { series, cell: null, verdict: 'Inconclusive' as const };
    const largest = candidates.reduce((left, right) =>
      leaves(right) > leaves(left) ? right : left,
    );
    const stage = diagnostic.stages.find((item) => item.cell === largest.id);
    const decisionBatch = decisionMedian(largest.id);
    if (!stage || decisionBatch === null)
      return { series, cell: largest.id, verdict: 'Inconclusive' as const };
    const s1 = median(stage.s1Ns);
    const s2 = median(stage.s2Ns);
    const s3 = median(stage.s3Ns);
    // Counts are recorded over the 10-path batch, matching the 10-path S3 batch.
    let exactNs = 0;
    let baselineNs = 0;
    let complete = true;
    for (const count of stage.counts) {
      const cost = unit.get(`${count.routine}|${count.instance}`);
      if (cost === undefined) complete = false;
      else {
        exactNs += count.calls * cost;
        baselineNs += count.calls * baseline;
      }
    }
    const share = exactNs / s3;
    const overhead = s3 / (decisionBatch * DECISION_PATHS);
    const verdict =
      !complete || overhead > config.h1.overheadLimit
        ? ('Inconclusive' as const)
        : share >= config.h1.supported
          ? ('Supported' as const)
          : share < config.h1.notSupported
            ? ('Not supported' as const)
            : ('Inconclusive' as const);
    return {
      series,
      cell: largest.id,
      stagesNs: { flatten: s1, topology: s2 - s1, tessellation: s3 - s2, total: s3 },
      countsPerPath: stage.counts.map((count) => ({
        routine: count.routine,
        instance: count.instance,
        calls: count.calls / DECISION_PATHS,
      })),
      exactShare: share,
      // Reported only: the share with the guard-only replay baseline removed.
      exactShareBaselineCorrected: Math.max(0, exactNs - baselineNs) / s3,
      unitCostsComplete: complete,
      overhead,
      verdict,
    };
  });
}

/** Rejects a record whose stored hash or analysis differs from a recomputation. */
export function validateRecord(record: B0Record): void {
  if (record.schemaVersion !== 1) throw new Error('unsupported schema version');
  if (configHash(record.scenario.config) !== record.scenario.configHash)
    throw new Error('configuration hash mismatch');
  if (canonicalJson(analyze(record)) !== canonicalJson(record.analysis))
    throw new Error('stored analysis differs from the recomputation');
}
