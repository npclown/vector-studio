/**
 * P3 Alt-A1 unit AL-U5 (`docs/plans/p3-alt-a1-fill-ladder-contract.md` sections 5.2-5.4):
 * scenario AL-S1, `p3-fill-ladder` v1. The configuration and its hash, the oracle-run
 * evaluation, the aggregates, fits, estimates, checks and provisional verdict of an AL-S1
 * record, its validator `validateLadderRecord`, the native analysis of the ratio mode that
 * AL-S2's native leg runs, and the product-stage estimates and verdict with k = k̂.
 *
 * Unchanged from B0 (section 5.3): the corpus bytes and cells, the admission pre-check, the
 * sampling, the fits, prediction bound and curvature guard, the validity checks 1-8 and the
 * budgets. B0's exported functions are imported unchanged, as the spike's analysis did, and
 * so are the spike's constants and the AL-U2 dump reader, input frame and oracles.
 *
 * How the AL-S1 record holds k: its configuration's `decision` is B0's, with k = 2, and its
 * verdict is labelled provisional. Its `analysis.estimates` also keeps the k-free t̂, t̂_p95,
 * m̂ and M̂. AL-S2's record supplies k̂ (and k̂₁, report-only) and computes the product verdict
 * with `productVerdict(analysis, kHat, s2Valid)` from the committed AL-S1 record.
 *
 * Erasable TypeScript only, so the Node runner can load it directly (with a resolve hook for
 * the `.js` specifiers of the modules it imports).
 */
import {
  canonicalJson,
  classify,
  configHash,
  fitSeries,
  leaves,
  nearestRank,
  summarize,
  validateRecord,
  type AdmissionCell,
  type B0Record,
  type Classification,
  type Fit,
} from '../p3-b0/analysis.js';
import {
  corpusCells,
  generateCellPaths,
  scenarioConfig as b0ScenarioConfig,
  type CellSpec,
  type Profile,
} from '../p3-b0/corpus.js';
import {
  B0_IDENTITY_RECORD,
  B0_REFERENCE_CONFIG_HASH,
  CORPUS_SHA256,
  e8U2FailureToSuccess,
  SPIKE_SCENARIO_ID,
  SPIKE_SCENARIO_VERSION,
} from '../p3-b0-spike/analysis.js';
import { sliverStatistics, type SpikeMesh } from '../p3-b0-spike/oracle.js';
import { div, mul, type Rational } from '../rounded-fill/exact.js';
import {
  b0Input,
  generateLadderCorpus,
  LADDER_CORPUS_ID,
  LADDER_PATHS,
  LADDER_SEED,
  ladderInput,
  type DumpInput,
} from './corpus.js';
import { DUMP_SCHEMA, type LadderDump, type LadderReason } from './dump.js';
import { evaluateEntry, type EntryEvaluation } from './oracle.js';

export const LADDER_SCENARIO_ID = 'p3-fill-ladder';
export const LADDER_SCENARIO_VERSION = 1;
export const LADDER_RUNNER_VERSION = 'p3-fill-ladder-runner/1';
export const LADDER_SCHEMA_VERSION = 1;
/** The production operation AL-S1 times (contract sections 2.1 and 5.3). */
export const OPERATION_ID = 'geometry-wasm/fill-v0+r4';
export const OPERATION_REVISION = 4;
/** The spike's reference configuration hash, recorded when SL-U3 merged; unchanged here. */
export const SPIKE_REFERENCE_CONFIG_HASH =
  '0daa96c068504c33dcf17ca787c1995db4972a76a006cd6db79473243fe72267';
/** SHA-256 of `p3-fill-ladder-random/v1` in the `P3BRRND1` frame, as AL-U2 pinned it. */
export const LADDER_CORPUS_SHA256 =
  'a597510de7fb1850daf89e98b398f642ded3d5d6bc1e3c5178bbd47e7e947bbc';
export { B0_IDENTITY_RECORD, B0_REFERENCE_CONFIG_HASH, CORPUS_SHA256 };

export const ORACLE_GATES = ['SL-O1', 'SL-O2', 'SL-O3', 'SL-O4', 'AL-I2', 'harness'] as const;
export type OracleGate = (typeof ORACLE_GATES)[number];

const DECISION_PATHS = 10;
const LINEARITY_PATHS = 100;
const LINEARITY_CELL = 'P4/s=16';
/** The export's status of every B0 cap code (V2 section e mapping); see `scenarioConfig`. */
const CAP_STATUSES = ['WORK_LIMIT'] as const;

export const CHECK_IDS = [
  '1-admitted-P2',
  '1-admitted-P4',
  '1-admitted-P8',
  '2-prediction-factor',
  '3-no-unverified-primary-cell',
  '4-linearity',
  '5-checksums-identical',
  '5b-admission-and-ladder-mix-identical',
  '6-flat-commands',
  '7-repetitions-complete',
  '8-metadata-complete',
] as const;

/** Section 5.3: B0's sampling, without B0's diagnostic run and H1 replay. */
function sampling(profile: Profile) {
  const b0 = b0ScenarioConfig(profile).sampling;
  return {
    repetitions: b0.repetitions,
    warmup: b0.warmup,
    timed: b0.timed,
    linearityWarmup: b0.linearityWarmup,
    linearityTimed: b0.linearityTimed,
    timeoutMinutes: 45,
    batchPaths: DECISION_PATHS,
    linearity: { cell: LINEARITY_CELL, paths: [DECISION_PATHS, LINEARITY_PATHS] },
  };
}

/** The largest-L cell of each primary series: the ratio mode's one-path cells (section 5.2). */
export function largestPrimaryCells(cells: readonly CellSpec[] = corpusCells()): string[] {
  const decision = b0ScenarioConfig('reference').decision;
  return decision.primarySeries.map((series) => {
    const seriesCells = cells.filter((cell) => cell.role === 'decision' && cell.series === series);
    return seriesCells.reduce((left, right) => (leaves(right) > leaves(left) ? right : left)).id;
  });
}

/** The configuration of section 5.3; its canonical JSON is hashed as in B0 section 7. */
export function scenarioConfig(profile: Profile) {
  const b0 = b0ScenarioConfig(profile);
  return {
    scenario: { id: LADDER_SCENARIO_ID, version: LADDER_SCENARIO_VERSION },
    profile,
    runner: LADDER_RUNNER_VERSION,
    reuses: {
      scenario: b0.scenario,
      referenceConfigHash: B0_REFERENCE_CONFIG_HASH,
      spike: {
        scenario: { id: SPIKE_SCENARIO_ID, version: SPIKE_SCENARIO_VERSION },
        referenceConfigHash: SPIKE_REFERENCE_CONFIG_HASH,
      },
    },
    generator: b0.generator,
    corpus: { sha256: CORPUS_SHA256, encoder: 'tests/geometry/p3-b0/corpus.ts encodeCorpus' },
    cells: b0.cells,
    operation: {
      id: OPERATION_ID,
      revision: OPERATION_REVISION,
      transportVersion: 0,
      call: 'FillEngine::process (native, release test-harness build, single thread)',
      request: {
        toleranceExponent: -3,
        fillRule: 'nonzero',
        requestId: 'the path index within its framed input',
      },
      limits: 'fill_export::FILL_V0_LIMITS',
    },
    timing: {
      batch:
        "E1: one process call on the cell's framed 10-path fill_v0 input; the window ends after the checksum fold of the output",
      path: 'E3 proxy: each path alone, one process call on its framed one-path input, timed individually after the batch in every sample',
      engine:
        'one FillEngine per cell, constructed and reserved outside timing, sized by an untimed preparation call on every input; storage compared before and after the samples',
      input: 'copied into the engine input before each window, outside it',
    },
    admission: {
      decisionPaths: DECISION_PATHS,
      linearityPaths: LINEARITY_PATHS,
      okRule:
        'a one-path process call returns BATCH_OK with path status OK (0) and a nonempty mesh',
      statuses:
        'path status by its V2 name (OK, EMPTY, INVALID_PATH, INVALID_TOLERANCE, NUMERIC_RANGE, WORK_LIMIT, UNSUPPORTED_GEOMETRY), or BATCH_STATUS(n)',
      capCodes: CAP_STATUSES,
      capRule:
        "B0's cap codes all reach the export as WORK_LIMIT (V2 section e mapping); CombinedByteLimit and EmissionStatus map to a batch internal error",
      ladder:
        'rung, reason, exact step and topology selection per path through build_path (FillEngine::build_one), untimed',
    },
    sampling: sampling(profile),
    checksum:
      'FNV-1a 64 over the output bytes [0, result_len) of each call; per sample the batch call, and the ten one-path calls chained in path order',
    aggregation: b0.aggregation,
    order: b0.order,
    fits: {
      ...b0.fits,
      seriesRoles: { primary: b0.decision.primarySeries, observational: ['K2', 'K4'] },
    },
    decision: b0.decision,
    estimates: {
      initial: 'T = 1000 * t * k',
      edit: 't_edit = t_p95 * k',
      mesh: 'M = 1000 * m, m from 16 V + 12 T (decided)',
      payload: '16 V + 12 T + 8 boundary pairs per path, reported only',
      k: 'decision.wasmFactor = 2 here, provisional as in B0; AL-S2 replaces it by its measured k-hat (productVerdict)',
    },
    ladderMix: 'per path: rung, reason, exact step and exact-rung topology selection (check 5b)',
    oracles: [
      { id: 'SL-O1', status: 'gate', what: 'exact certificate at each path delta, AL-FR0, AL-M5' },
      { id: 'SL-O2', status: 'gate', what: 'exact region and mesh validity of the export output' },
      { id: 'SL-O3', status: 'gate', what: 'same input polygon and exact area band' },
      { id: 'SL-O4', status: 'gate', what: 'exact rung reproduces the 2026-10-17 record' },
      { id: 'AL-I2', status: 'gate', what: 'fallback export output equals exact_only' },
      { id: 'harness', status: 'gate', what: 'zero allocations in a ladder call; rung records' },
      { id: 'MESH_CHECK', status: 'gate', what: 'the MESH_CHECK count is 0' },
      { id: 'AL-I3', status: 'observation', what: 'differential against the frozen spike' },
      { id: 'SL-O5', status: 'observation', what: 'sliver statistics per group and rung' },
      { id: 'SL-O6', status: 'observation', what: 'geometric error shares' },
      { id: 'O1/O2', status: 'observation', what: 'generic-coordinate and crossing admission' },
    ],
    oracleRun: {
      dump: DUMP_SCHEMA,
      paths:
        'every B0 corpus path (0-9 per decision cell, 0-99 of P4/s=16, 0-29 per O1 cell, every X path) and the full randomized family',
      randomized: {
        id: LADDER_CORPUS_ID,
        seed: LADDER_SEED,
        paths: LADDER_PATHS,
        sha256: LADDER_CORPUS_SHA256,
      },
      identityRecord: B0_IDENTITY_RECORD,
    },
    ratioMode: 'outside this scenario and its verdict; ratioModeConfig belongs to AL-S2',
    checks: CHECK_IDS,
  };
}

export type LadderConfig = ReturnType<typeof scenarioConfig>;

/**
 * The ratio mode of section 5.2, AL-S2's native leg. It is not part of AL-S1's configuration
 * hash; AL-S2's configuration embeds it.
 */
export function ratioModeConfig(profile: Profile) {
  const sample = sampling(profile);
  return {
    harness: 'p3_fill_ladder_bench::run_ladder_ratio',
    operation: OPERATION_ID,
    cells: 'the 34 decision cells, paths 0-9, framed as one 10-path input',
    calls: 100,
    onePath: { cells: largestPrimaryCells(), path: 0, calls: 1000 },
    sampling: {
      repetitions: sample.repetitions,
      warmup: sample.warmup,
      timed: sample.timed,
    },
    order: 'the decision cells, then the one-path cells, each shuffled per repetition as in B0',
    window:
      'from before the first process call to after the last call fold; one fold per call; the input loaded and the engine sized outside timing',
    fold: 'FNV-1a 64 chained over the calls of a sample: per path in output order the status as u32 LE; on OK also V, T and the boundary pair count as u32 LE, then the position f64 bits LE (x, y), the indices u32 LE and the boundary pairs u32 LE',
    perPath: 'median sample / (calls * paths per call)',
    unverified: 'a sample shorter than 100 clock quanta',
  };
}

// ------------------------------------------------------------------------------------------
// Record types.

export interface LadderAdmissionPath {
  readonly status: string;
  readonly rung: 'fast' | 'exact' | 'none';
  readonly reason: LadderReason | null;
  readonly step: 'Legacy' | 'TriangleFree' | null;
  readonly flatCommands?: number;
  readonly vertices?: number;
  readonly triangles?: number;
  readonly boundaryPairs?: number;
  readonly rounded: boolean;
  readonly transverse: boolean;
  readonly allocations: number;
}
export interface LadderAdmissionCell {
  readonly cell: string;
  readonly paths: readonly LadderAdmissionPath[];
}
export interface LadderDecisionOutput {
  readonly kind: 'decision';
  readonly repetition: number;
  readonly revision: number;
  readonly clockQuantumNs: number;
  readonly engine: { readonly inlineBytes: number; readonly heapBytes: number };
  readonly admission: readonly LadderAdmissionCell[];
  readonly order: readonly string[];
  readonly cells: readonly {
    readonly cell: string;
    readonly engineNs: number;
    /** E5 of the cell's prepared engine: workspace, scratch and ladder storage. */
    readonly heapBytes: number;
    /** The prepared engine's input plus output buffer capacity, outside `heapBytes`. */
    readonly bufferBytes: number;
    readonly batchAllocations: number;
    readonly storageStable: boolean;
    readonly batchNs: readonly number[];
    readonly pathNs: readonly number[];
    readonly checksums: readonly string[];
    readonly pathChecksums: readonly string[];
  }[];
  readonly linearity: {
    readonly cell: string;
    readonly storageStable: boolean;
    readonly batch10Ns: readonly number[];
    readonly checksums10: readonly string[];
    readonly batch100Ns: readonly number[];
    readonly checksums100: readonly string[];
  } | null;
}

/** The Rust side of the oracle run (`run_ladder_oracle`), without the dump. */
export interface LadderOracleHarness {
  readonly kind: 'oracle';
  readonly revision: number;
  readonly entries: number;
  /** Per path entry of the dump input, in order: the ladder record through `build_path`. */
  readonly paths: readonly {
    readonly name: string;
    readonly rung: 'fast' | 'exact' | 'none';
    readonly reason: LadderReason | null;
    readonly step: 'Legacy' | 'TriangleFree' | null;
    readonly status: string;
    readonly mesh: boolean;
    readonly alI2: boolean;
  }[];
  readonly alI2: { readonly checked: number; readonly failures: readonly string[] };
  /** Per B0 corpus cell, every path: the exact rung as B0 called it. */
  readonly exactOutcomes: readonly AdmissionCell[];
  readonly exactChecksums: readonly {
    readonly cell: string;
    readonly checksum10: string | null;
    readonly checksum100?: string | null;
  }[];
}

export interface SliverAggregate {
  readonly group: string;
  readonly rung: 'fast' | 'exact';
  readonly meshes: number;
  readonly triangles: number;
  readonly nonFinite: number;
  readonly quality: { readonly min: number; readonly p5: number; readonly median: number } | null;
  readonly angle: { readonly min: number; readonly p5: number; readonly median: number } | null;
  readonly below01: number;
  readonly below001: number;
}

/** The evaluated oracle run, stored in the record. */
export interface LadderOracleResults {
  readonly dump: {
    readonly sha256: string;
    readonly bytes: number;
    readonly entries: number;
    readonly revision: number;
  };
  readonly gates: Readonly<
    Record<OracleGate, { readonly checked: number; readonly failures: readonly string[] }>
  >;
  readonly meshCheck: { readonly count: number; readonly entries: readonly string[] };
  readonly alI3: {
    readonly checked: number;
    readonly identical: number;
    readonly allowed: Readonly<Record<'RANGE' | 'AL-M5', number>>;
    readonly differing: readonly string[];
  };
  /** Per group (B0 cell, or `ladder`): the ladder mix through `build_path`. */
  readonly mix: readonly {
    readonly group: string;
    readonly paths: number;
    readonly fast: number;
    readonly fallbacks: Readonly<Partial<Record<LadderReason, number>>>;
    readonly published: number;
    readonly exactPublished: number;
    readonly conservative: number;
  }[];
  readonly o1: readonly {
    readonly cell: string;
    readonly fast: number;
    readonly fallbacks: Readonly<Partial<Record<LadderReason, number>>>;
    readonly published: number;
    readonly conservative: number;
    readonly referenceExactOk: number;
  }[];
  readonly o2: readonly {
    readonly cell: string;
    readonly paths: number;
    readonly crossing: number;
    readonly statuses: Readonly<Record<string, number>>;
    readonly asExpected: boolean;
  }[];
  readonly slivers: readonly SliverAggregate[];
  readonly geometricError: readonly {
    readonly group: string;
    readonly fastPaths: number;
    readonly maxCertifiedOverDelta: number | null;
    readonly maxExactOverDelta: number | null;
    readonly contractedContours: number;
  }[];
  readonly checksums: readonly {
    readonly cell: string;
    readonly checksum10: string | null;
    readonly reference10: string | null;
    readonly checksum100?: string | null;
    readonly reference100?: string | null;
  }[];
}

export interface LadderRecord {
  readonly schemaVersion: 1;
  readonly scenario: {
    readonly id: string;
    readonly version: number;
    readonly profile: Profile;
    readonly config: LadderConfig;
    readonly configHash: string;
  };
  readonly run: Record<string, unknown>;
  readonly environment: Record<string, unknown>;
  readonly builds: Record<string, unknown>;
  readonly corpus: { readonly sha256: string; readonly bytes: number };
  readonly repetitions: readonly LadderDecisionOutput[];
  readonly oracle: LadderOracleResults | null;
  readonly failures?: readonly { stage: string; error: string; log: string }[];
  readonly analysis?: unknown;
}

// ------------------------------------------------------------------------------------------
// The oracle run (section 5.3).

/** The full dump set of section 4.2, in order: every B0 corpus path, then the family. */
export function oracleDumpInputs(): DumpInput[] {
  const inputs: DumpInput[] = [];
  for (const cell of corpusCells())
    generateCellPaths(cell).forEach((path, index) =>
      inputs.push(b0Input(cell.id, index, path.verbs, path.points)),
    );
  generateLadderCorpus().forEach((path, index) => inputs.push(ladderInput(index, path)));
  return inputs;
}

/** The dump entry names the oracle run must hold, each exactly once. */
export function oracleDumpNames(): string[] {
  const names: string[] = [];
  for (const cell of corpusCells())
    for (let index = 0; index < cell.paths; index += 1) names.push(`b0/${cell.id}#${index}`);
  for (let index = 0; index < LADDER_PATHS; index += 1) names.push(`ladder/${index}`);
  return names;
}

/** A dump entry's report group: its B0 cell, or `ladder`. */
function groupOf(name: string): string {
  return name.startsWith('b0/') ? name.slice(3, name.lastIndexOf('#')) : name.split('/')[0]!;
}

function sliverAggregate(
  group: string,
  rung: 'fast' | 'exact',
  meshes: readonly SpikeMesh[],
): SliverAggregate {
  const all = meshes.flatMap((mesh) => sliverStatistics(mesh).perTriangle);
  // Huge-scale paths of the randomized family can overflow the Float64 statistics.
  const values = all.filter(
    (value) => Number.isFinite(value.quality) && Number.isFinite(value.angle),
  );
  const base = {
    group,
    rung,
    meshes: meshes.length,
    triangles: all.length,
    nonFinite: all.length - values.length,
  };
  if (values.length === 0) return { ...base, quality: null, angle: null, below01: 0, below001: 0 };
  const summary = (items: readonly number[]) => {
    const sorted = [...items].sort((left, right) => left - right);
    return { min: sorted[0]!, p5: nearestRank(sorted, 0.05), median: nearestRank(sorted, 0.5) };
  };
  const qualities = values.map((value) => value.quality);
  return {
    ...base,
    quality: summary(qualities),
    angle: summary(values.map((value) => value.angle)),
    below01: qualities.filter((value) => value < 0.1).length,
    below001: qualities.filter((value) => value < 0.01).length,
  };
}

/** The exact-rung fields that SL-O4 compares with the 2026-10-17 record. */
function outcomeKey(path: {
  status: string;
  flatCommands?: number;
  vertices?: number;
  triangles?: number;
  rounded: boolean;
  transverse: boolean;
}): string {
  return canonicalJson({
    status: path.status,
    flatCommands: path.status === 'OK' ? path.flatCommands : undefined,
    vertices: path.status === 'OK' ? path.vertices : undefined,
    triangles: path.status === 'OK' ? path.triangles : undefined,
    rounded: path.rounded,
    transverse: path.transverse,
  });
}

/** The single checksum value a B0 record holds for a cell, or null when there is not one. */
function referenceChecksum(reference: B0Record, cell: string, large: boolean): string | null {
  const values = new Set<string>();
  for (const rep of reference.repetitions) {
    if (large) {
      if (rep.linearity?.cell === cell) rep.linearity.checksums100.forEach((v) => values.add(v));
      continue;
    }
    rep.cells.find((item) => item.cell === cell)?.checksums.forEach((value) => values.add(value));
    if (rep.linearity?.cell === cell) rep.linearity.checksums10.forEach((v) => values.add(v));
  }
  return values.size === 1 ? [...values][0]! : null;
}

/** value / unit as a float, for reports only; exact BigInt scaling, so huge terms stay finite. */
function quotient(value: Rational, unit: Rational): number {
  const q = div(value, unit);
  if (q.n === 0n) return 0;
  const bits = (x: bigint) => (x < 0n ? -x : x).toString(2).length;
  const shift = bits(q.d) - bits(q.n) + 64;
  const scaled = shift >= 0 ? (q.n << BigInt(shift)) / q.d : q.n / (q.d << BigInt(-shift));
  return Number(scaled) * 2 ** -shift;
}

function hexNumber(bits: string): number {
  const view = new DataView(new ArrayBuffer(8));
  view.setBigUint64(0, BigInt(`0x${bits}`));
  return view.getFloat64(0);
}

/**
 * Applies the oracle run's gates to the dump and the harness output (section 5.3): SL-O1 to
 * SL-O3 with AL-U2's `evaluateEntry` on every entry, SL-O4 against the 2026-10-17 B0 record
 * (whose configuration hash is recomputed and whose analysis B0's own validator re-checks),
 * AL-I2 on every fallback path (module level from the dump, export level from the harness),
 * the harness checks (zero allocations in a ladder call, `build_path`'s rung equal to the
 * module ladder's, the kernel revision), the dump's completeness and the `MESH_CHECK` count;
 * then AL-I3, SL-O5, SL-O6 and O1/O2 as observations. Pure: the runner passes the parsed dump,
 * the harness output, the dump's hash and size, the B0 record and the expected names.
 */
export function evaluateLadderOracle(
  dump: LadderDump,
  harness: LadderOracleHarness,
  dumpIdentity: { sha256: string; bytes: number },
  reference: B0Record,
  expectedNames: readonly string[] = oracleDumpNames(),
): LadderOracleResults {
  const gates: Record<OracleGate, { checked: number; failures: string[] }> = {
    'SL-O1': { checked: 0, failures: [] },
    'SL-O2': { checked: 0, failures: [] },
    'SL-O3': { checked: 0, failures: [] },
    'SL-O4': { checked: 0, failures: [] },
    'AL-I2': { checked: 0, failures: [] },
    harness: { checked: 0, failures: [] },
  };
  const fail = (gate: OracleGate, detail: string) => gates[gate].failures.push(detail);
  if (dump.revision !== OPERATION_REVISION || harness.revision !== OPERATION_REVISION)
    fail('harness', `kernel revision ${dump.revision}/${harness.revision}, not 4`);

  const records = new Map(harness.paths.map((path) => [path.name, path]));
  const meshCheck: string[] = [];
  const alI3 = {
    checked: 0,
    identical: 0,
    allowed: { RANGE: 0, 'AL-M5': 0 },
    differing: [] as string[],
  };
  interface Group {
    paths: number;
    fast: number;
    fallbacks: Partial<Record<LadderReason, number>>;
    published: number;
    exactPublished: number;
    conservative: number;
    crossing: number;
    statuses: Record<string, number>;
    fastMeshes: SpikeMesh[];
    exactMeshes: SpikeMesh[];
    maxCertified: number | null;
    maxExact: number | null;
    contracted: number;
  }
  const groups = new Map<string, Group>();
  for (const entry of dump.entries) {
    const evaluation: EntryEvaluation = evaluateEntry(entry, dump.revision);
    for (const gate of ['SL-O1', 'SL-O2', 'SL-O3'] as const) {
      if (evaluation.checked[gate]) gates[gate].checked += 1;
      for (const failure of evaluation.failures[gate]) fail(gate, `${entry.name}: ${failure}`);
    }
    // Harness: no allocation inside a ladder call; MESH_CHECK is counted separately.
    gates.harness.checked += 1;
    if (entry.allocations !== 0) fail('harness', `${entry.name}: ${entry.allocations} allocations`);
    if (entry.reason === 'MESH_CHECK') meshCheck.push(entry.name);
    // AL-I2 at module level: the ladder's exact result is the exact rung run alone.
    if (entry.kind === 'path' && entry.rung === 'fallback') {
      gates['AL-I2'].checked += 1;
      if (entry.ladderExactAgrees !== true)
        fail('AL-I2', `${entry.name}: the ladder's exact result differs from the exact rung`);
    }
    // AL-I3, an observation here.
    if (evaluation.checked['AL-I3']) {
      alI3.checked += 1;
      if (evaluation.allowedDifference !== null) alI3.allowed[evaluation.allowedDifference] += 1;
      else if (evaluation.failures['AL-I3'].length > 0)
        alI3.differing.push(`${entry.name}: ${evaluation.failures['AL-I3'].join('; ')}`);
      else alI3.identical += 1;
    }
    // The ladder record through build_path equals the module ladder's outcome.
    const built = records.get(entry.name);
    if (entry.kind === 'path') {
      if (built === undefined) fail('harness', `${entry.name}: no build_path record`);
      else if (
        (built.rung === 'fast') !== (entry.rung === 'fast') ||
        (entry.rung === 'fallback' && built.reason !== entry.reason)
      )
        fail(
          'harness',
          `${entry.name}: build_path ${built.rung} ${built.reason ?? ''} against the ladder ${entry.rung} ${entry.reason ?? ''}`,
        );
    }

    const name = groupOf(entry.name);
    const group: Group = groups.get(name) ?? {
      paths: 0,
      fast: 0,
      fallbacks: {},
      published: 0,
      exactPublished: 0,
      conservative: 0,
      crossing: 0,
      statuses: {},
      fastMeshes: [],
      exactMeshes: [],
      maxCertified: null,
      maxExact: null,
      contracted: 0,
    };
    groups.set(name, group);
    group.paths += 1;
    if (entry.rung === 'fast') group.fast += 1;
    else if (entry.reason) group.fallbacks[entry.reason] = (group.fallbacks[entry.reason] ?? 0) + 1;
    if (entry.reason === 'CROSSING') group.crossing += 1;
    if (evaluation.judgement?.conservative === true && entry.rung === 'fallback')
      group.conservative += 1;
    if (built) {
      group.statuses[built.status] = (group.statuses[built.status] ?? 0) + 1;
      if (built.status === 'OK') group.published += 1;
      if (built.status === 'OK' && built.rung === 'exact') group.exactPublished += 1;
    }
    if (entry.exact?.mesh) group.exactMeshes.push(entry.exact.mesh);
    if (entry.rung === 'fast' && evaluation.fastOutput) {
      group.fastMeshes.push(evaluation.fastOutput.mesh);
      const delta = 2 ** entry.exponent;
      if (entry.maxDeviationSquared !== null) {
        const certified = Math.sqrt(hexNumber(entry.maxDeviationSquared)) / delta;
        if (Number.isFinite(certified))
          group.maxCertified =
            group.maxCertified === null ? certified : Math.max(group.maxCertified, certified);
      }
      const certificate = evaluation.certificate;
      if (certificate?.maxDeviationSquared) {
        const exact = Math.sqrt(
          quotient(certificate.maxDeviationSquared, mul(certificate.delta, certificate.delta)),
        );
        if (Number.isFinite(exact))
          group.maxExact = group.maxExact === null ? exact : Math.max(group.maxExact, exact);
      }
      group.contracted += certificate?.alM5.contracted ?? 0;
    }
  }
  // AL-I2 at export level: the one-path export output equals exact_only byte for byte.
  gates['AL-I2'].checked += harness.alI2.checked;
  for (const name of harness.alI2.failures) fail('AL-I2', `${name}: export output differs`);
  if (harness.paths.length !== dump.entries.filter((entry) => entry.kind === 'path').length)
    fail('harness', 'harness and dump path counts differ');

  // SL-O4 premise: the identity record is the unchanged B0 v1 reference run.
  if (configHash(reference.scenario.config) !== B0_REFERENCE_CONFIG_HASH)
    fail('SL-O4', 'identity record configuration hash differs');
  try {
    validateRecord(reference);
  } catch (error) {
    fail('SL-O4', `identity record rejected by B0's validator: ${(error as Error).message}`);
  }
  if (reference.corpus.sha256 !== CORPUS_SHA256)
    fail('SL-O4', 'identity record corpus hash differs');
  const referenceOutcomes = new Map<string, AdmissionCell>();
  for (const cell of reference.repetitions[0]?.admission ?? [])
    referenceOutcomes.set(cell.cell, cell);
  for (const cell of reference.diagnostic?.observations ?? [])
    referenceOutcomes.set(cell.cell, cell);
  const cells = reference.scenario.config.cells;
  for (const spec of cells) {
    const produced = harness.exactOutcomes.find((item) => item.cell === spec.id);
    const expected = referenceOutcomes.get(spec.id);
    if (!produced || produced.paths.length !== spec.paths) {
      fail('SL-O4', `${spec.id}: ${produced?.paths.length ?? 0} exact outcomes for ${spec.paths}`);
      continue;
    }
    produced.paths.forEach((path, index) => {
      gates['SL-O4'].checked += 1;
      const want = expected?.paths[index];
      if (!want) fail('SL-O4', `${spec.id}#${index}: no outcome in the identity record`);
      else if (
        outcomeKey(path) !== outcomeKey(want) &&
        !e8U2FailureToSuccess(want.status, path.status)
      )
        fail('SL-O4', `${spec.id}#${index}: exact ${outcomeKey(path)} != ${outcomeKey(want)}`);
    });
  }
  const checksums = harness.exactChecksums.map((entry) => {
    gates['SL-O4'].checked += 1;
    const reference10 = referenceChecksum(reference, entry.cell, false);
    if (entry.checksum10 === null || entry.checksum10 !== reference10)
      fail('SL-O4', `${entry.cell}: checksum ${entry.checksum10} != record ${reference10}`);
    if (entry.checksum100 === undefined)
      return { cell: entry.cell, checksum10: entry.checksum10, reference10 };
    gates['SL-O4'].checked += 1;
    const reference100 = referenceChecksum(reference, entry.cell, true);
    if (entry.checksum100 === null || entry.checksum100 !== reference100)
      fail('SL-O4', `${entry.cell}: 100-path checksum differs from the record`);
    return {
      cell: entry.cell,
      checksum10: entry.checksum10,
      reference10,
      checksum100: entry.checksum100,
      reference100,
    };
  });
  const decisionCells = cells.filter((cell) => cell.role === 'decision').length;
  if (checksums.length !== decisionCells)
    fail('SL-O4', `${checksums.length} checksums for ${decisionCells} decision cells`);
  // The dump is complete: every expected name exactly once, and nothing else.
  const seen = new Map<string, number>();
  for (const entry of dump.entries) seen.set(entry.name, (seen.get(entry.name) ?? 0) + 1);
  for (const name of expectedNames) {
    const count = seen.get(name) ?? 0;
    if (count !== 1) fail('SL-O4', `dump has ${name} ${count} times`);
  }
  if (dump.entries.length !== expectedNames.length || harness.entries !== expectedNames.length)
    fail(
      'SL-O4',
      `dump has ${dump.entries.length} entries (harness ${harness.entries}) for ${expectedNames.length} expected`,
    );

  const mix: LadderOracleResults['mix'][number][] = [];
  const o1: LadderOracleResults['o1'][number][] = [];
  const o2: LadderOracleResults['o2'][number][] = [];
  const slivers: SliverAggregate[] = [];
  const geometricError: LadderOracleResults['geometricError'][number][] = [];
  for (const [name, group] of groups) {
    mix.push({
      group: name,
      paths: group.paths,
      fast: group.fast,
      fallbacks: group.fallbacks,
      published: group.published,
      exactPublished: group.exactPublished,
      conservative: group.conservative,
    });
    if (name.startsWith('O1/'))
      o1.push({
        cell: name,
        fast: group.fast,
        fallbacks: group.fallbacks,
        published: group.published,
        conservative: group.conservative,
        referenceExactOk:
          referenceOutcomes.get(name)?.paths.filter((item) => item.status === 'OK').length ?? 0,
      });
    if (name.startsWith('X/'))
      o2.push({
        cell: name,
        paths: group.paths,
        crossing: group.crossing,
        statuses: group.statuses,
        asExpected: group.crossing === group.paths,
      });
    slivers.push(sliverAggregate(name, 'fast', group.fastMeshes));
    slivers.push(sliverAggregate(name, 'exact', group.exactMeshes));
    geometricError.push({
      group: name,
      fastPaths: group.fast,
      maxCertifiedOverDelta: group.maxCertified,
      maxExactOverDelta: group.maxExact,
      contractedContours: group.contracted,
    });
  }
  return {
    dump: { ...dumpIdentity, entries: dump.entries.length, revision: dump.revision },
    gates,
    meshCheck: { count: meshCheck.length, entries: meshCheck },
    alI3,
    mix,
    o1,
    o2,
    slivers,
    geometricError,
    checksums,
  };
}

/** Gate status recomputed from the stored failure lists (an empty gate does not pass). */
export function oracleStatus(oracle: LadderOracleResults | null) {
  if (oracle === null)
    return {
      present: false,
      valid: false,
      meshCheckZero: false,
      gates: ORACLE_GATES.map((id) => ({ id, checked: 0, failures: 0, pass: false })),
    };
  const gates = ORACLE_GATES.map((id) => {
    const gate = oracle.gates[id];
    return {
      id,
      checked: gate.checked,
      failures: gate.failures.length,
      pass: gate.checked > 0 && gate.failures.length === 0,
    };
  });
  return {
    present: true,
    valid: gates.every((gate) => gate.pass),
    meshCheckZero: oracle.meshCheck.count === 0,
    gates,
  };
}

// ------------------------------------------------------------------------------------------
// Aggregates, fits, estimates, checks and verdict (B0 sections 3 and 5, contract 5.3).

const REQUIRED_ENVIRONMENT = [
  'observedAt',
  'os',
  'cpu',
  'logicalCores',
  'memoryBytes',
  'timezone',
  'power',
  'backgroundLoad',
  'processListing',
];

interface Check {
  readonly id: string;
  readonly pass: boolean;
  readonly detail: string;
}

function median(values: readonly number[]): number {
  return summarize(values).median;
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

/** The ladder mix of one admission cell: everything but the allocation counts. */
function ladderMix(cell: LadderAdmissionCell) {
  return { cell: cell.cell, paths: cell.paths.map((path) => ({ ...path, allocations: 0 })) };
}

function ladderTable(cell: LadderAdmissionCell) {
  const fallbacks: Partial<Record<LadderReason, number>> = {};
  let fast = 0;
  for (const path of cell.paths) {
    if (path.rung === 'fast') fast += 1;
    else if (path.reason) fallbacks[path.reason] = (fallbacks[path.reason] ?? 0) + 1;
  }
  const paths = cell.paths.length;
  return { paths, fast, fallbacks, fallbackRate: paths === 0 ? null : (paths - fast) / paths };
}

export type Verdict = 'NONE' | 'INVALID' | 'FEASIBLE' | 'INFEASIBLE' | 'INCONCLUSIVE';

export function analyze(record: LadderRecord) {
  const config = record.scenario.config;
  const decision = config.decision;
  const cells = config.cells.filter((cell) => cell.role === 'decision');
  const specOf = new Map<string, CellSpec>(config.cells.map((cell) => [cell.id, cell]));
  const reps = [...record.repetitions].sort((left, right) => left.repetition - right.repetition);
  const checks: Check[] = [];
  const check = (id: string, pass: boolean, detail: string) => checks.push({ id, pass, detail });

  // Admission from repetition 0, with B0's classification and the export's cap status.
  const admission = cells.map((spec) => {
    const entry = reps[0]?.admission.find((item) => item.cell === spec.id);
    const decisionPaths = config.admission.decisionPaths;
    const result: {
      classification: Classification;
      firstFailure: { path: number; code: string } | null;
    } = entry
      ? classify(entry, config.admission.capCodes, decisionPaths)
      : { classification: 'NOT-ADMITTED', firstFailure: null };
    const okPaths =
      result.classification === 'ADMITTED' && entry ? entry.paths.slice(0, decisionPaths) : [];
    const mean = (bytes: (path: LadderAdmissionPath) => number) =>
      okPaths.length === 0
        ? null
        : okPaths.reduce((sum, path) => sum + bytes(path), 0) / okPaths.length;
    return {
      cell: spec.id,
      series: spec.series,
      leaves: leaves(spec),
      ...result,
      meanMeshBytes: mean((path) => 16 * path.vertices! + 12 * path.triangles!),
      meanPayloadBytes: mean(
        (path) => 16 * path.vertices! + 12 * path.triangles! + 8 * path.boundaryPairs!,
      ),
    };
  });
  const admitted = new Set(
    admission.filter((item) => item.classification === 'ADMITTED').map((item) => item.cell),
  );

  // Fallback-rate reporting: per decision cell and repetition.
  const fallbackRates = reps.map((rep) => ({
    repetition: rep.repetition,
    cells: rep.admission.map((cell) => ({ cell: cell.cell, ...ladderTable(cell) })),
  }));
  const firstRates = fallbackRates[0]?.cells ?? [];
  const seriesFallback = decision.primarySeries.map((series) => {
    const seriesCells = cells.filter((spec) => spec.series === series);
    const largest = seriesCells.reduce((left, right) =>
      leaves(right) > leaves(left) ? right : left,
    );
    const entry = firstRates.find((item) => item.cell === largest.id);
    return { series, cell: largest.id, fallbackRate: entry?.fallbackRate ?? null };
  });
  let timedPaths = 0;
  let timedFast = 0;
  for (const cell of reps[0]?.admission ?? []) {
    if (!admitted.has(cell.cell)) continue;
    for (const path of cell.paths.slice(0, DECISION_PATHS)) {
      timedPaths += 1;
      if (path.rung === 'fast') timedFast += 1;
    }
  }
  const timedFastShare = timedPaths === 0 ? null : timedFast / timedPaths;

  const firstMix = (reps[0]?.admission ?? []).map(ladderMix);
  check(
    '5b-admission-and-ladder-mix-identical',
    reps.every((rep) => canonicalJson(rep.admission.map(ladderMix)) === canonicalJson(firstMix)),
    `${reps.length} repetitions compared; first ladder mix hash ${configHash(firstMix).slice(0, 12)}`,
  );

  // Per-cell aggregates per repetition.
  const perCell = cells.map((spec) => {
    const perRepetition = reps.flatMap((rep) => {
      const timed = rep.cells.find((cell) => cell.cell === spec.id);
      if (!timed) return [];
      return [
        {
          repetition: rep.repetition,
          unverified: timed.batchNs.some(
            (ns) => ns < decision.quantumMultiple * rep.clockQuantumNs,
          ),
          batchAllocations: timed.batchAllocations,
          storageStable: timed.storageStable,
          engineNs: timed.engineNs,
          batch: summarize(timed.batchNs.map((ns) => ns / DECISION_PATHS)),
          path: summarize(timed.pathNs),
        },
      ];
    });
    return { cell: spec.id, series: spec.series, leaves: leaves(spec), perRepetition };
  });

  // Fits, with B0's fitSeries.
  const fits: Fit[] = [];
  for (const series of [...decision.primarySeries, 'K2']) {
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

  // B0's validity checks 1-8, check 5 with the ladder mix as 5b.
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
  let maxFactor = -Infinity;
  for (const fit of primaryFits) maxFactor = Math.max(maxFactor, fit.predictionFactor ?? Infinity);
  check(
    '2-prediction-factor',
    primaryFits.length > 0 &&
      primaryFits.every(
        (fit) =>
          fit.predictionFactor !== null && fit.predictionFactor <= decision.predictionFactorLimit,
      ),
    `max factor ${maxFactor.toFixed(3)}`,
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
    const value = large / small;
    return {
      repetition: rep.repetition,
      perPath10Ns: small,
      perPath100Ns: large,
      ratio: value,
      pass: value <= decision.linearityLimit,
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
    const pathSums = new Set<string>();
    for (const rep of reps) {
      const timed = rep.cells.find((cell) => cell.cell === spec.id);
      timed?.checksums.forEach((sum) => sums.add(sum));
      timed?.pathChecksums.forEach((sum) => pathSums.add(sum));
      if (rep.linearity && rep.linearity.cell === spec.id)
        rep.linearity.checksums10.forEach((sum) => sums.add(sum));
    }
    if (sums.size > 1) checksumIssues.push(spec.id);
    if (pathSums.size > 1) checksumIssues.push(`${spec.id} paths`);
  }
  if (new Set(reps.flatMap((rep) => rep.linearity?.checksums100 ?? [])).size > 1)
    checksumIssues.push('linearity-100');
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
    flatIssues.join(', ') || 'L + 2C on every path',
  );

  const expectedReps = config.sampling.repetitions;
  check(
    '7-repetitions-complete',
    reps.length === expectedReps && reps.every((rep, index) => rep.repetition === index),
    `${reps.length} of ${expectedReps}`,
  );
  const missing = [
    ...REQUIRED_ENVIRONMENT.filter(
      (key) => record.environment[key] === undefined || record.environment[key] === null,
    ),
    ...[
      ['run.commit', record.run.commit],
      ['run.sourceManifest', record.run.sourceManifest],
      ['run.runner', record.run.runner],
      ['builds.toolchain', record.builds.toolchain],
      ['builds.decision', record.builds.decision],
      ['corpus.sha256', record.corpus.sha256],
    ]
      .filter(([, value]) => value === undefined || value === null || value === '')
      .map(([name]) => name as string),
  ];
  check('8-metadata-complete', missing.length === 0, missing.join(', ') || 'complete');

  // Estimates (B0 section 5, unchanged), with the k-free values kept for AL-S2.
  const estimateOf = (kind: 'median' | 'p95') => {
    let best: number | null = null;
    for (const fit of primaryFits)
      if (fit.kind === kind && fit.estimateNs !== null)
        best = best === null ? fit.estimateNs : Math.max(best, fit.estimateNs);
    return best;
  };
  const perPathNs = estimateOf('median');
  const p95Ns = estimateOf('p95');
  const perSeries = (key: 'meanMeshBytes' | 'meanPayloadBytes') => {
    const values = decision.primarySeries.map((series) => {
      const seriesCells = admission.filter(
        (item) =>
          item.series === series && item.classification === 'ADMITTED' && item[key] !== null,
      );
      const lambda = cells.find((spec) => spec.series === series)!.lambda;
      return linear(
        seriesCells.map((item) => ({ x: item.leaves, y: item[key]! })),
        decision.workloadCubics * lambda,
      );
    });
    return values.some((value) => value === null) ? null : Math.max(...(values as number[]));
  };
  const meshPerPath = perSeries('meanMeshBytes');
  const payloadPerPath = perSeries('meanPayloadBytes');
  const estimates =
    perPathNs === null || p95Ns === null || meshPerPath === null
      ? null
      : {
          wasmFactor: decision.wasmFactor,
          provisional: true,
          perPathNs,
          p95Ns,
          meshPerPathBytes: meshPerPath,
          payloadPerPathBytes: payloadPerPath,
          initialMs: (decision.workloadPaths * perPathNs * decision.wasmFactor) / 1e6,
          editMs: (p95Ns * decision.wasmFactor) / 1e6,
          meshBytes: decision.workloadPaths * meshPerPath,
          payloadBytes: payloadPerPath === null ? null : decision.workloadPaths * payloadPerPath,
        };
  const ratios =
    estimates === null
      ? null
      : {
          initial: estimates.initialMs / decision.budgets.initialMs,
          edit: estimates.editMs / decision.budgets.editMs,
          mesh: estimates.meshBytes / decision.budgets.meshBytes,
        };

  const oracle = oracleStatus(record.oracle);
  const checksumsPass = checks.find((item) => item.id === '5-checksums-identical')!.pass;
  const storageStable =
    perCell.every((cell) => cell.perRepetition.every((item) => item.storageStable)) &&
    reps.every((rep) => rep.linearity === null || rep.linearity.storageStable);
  const revisionOk = reps.every((rep) => rep.revision === OPERATION_REVISION);
  // Section 5.3: an oracle failure (any gate, the harness checks and AL-I2 included), a
  // nonzero MESH_CHECK count or a checksum mismatch invalidates the run; so do storage moved
  // during timing and a kernel of another revision.
  const invalidReasons = [
    ...(oracle.valid ? [] : ['oracle gate']),
    ...(oracle.meshCheckZero ? [] : ['MESH_CHECK']),
    ...(checksumsPass ? [] : ['checksum mismatch']),
    ...(storageStable ? [] : ['storage moved during timing']),
    ...(revisionOk ? [] : ['kernel revision']),
  ];
  let verdict: Verdict;
  if (record.scenario.profile !== 'reference') verdict = 'NONE';
  else if (invalidReasons.length > 0) verdict = 'INVALID';
  else if (!checks.every((item) => item.pass) || estimates === null) verdict = 'INCONCLUSIVE';
  else
    verdict =
      estimates.initialMs <= decision.budgets.initialMs &&
      estimates.editMs <= decision.budgets.editMs &&
      estimates.meshBytes <= decision.budgets.meshBytes
        ? 'FEASIBLE'
        : 'INFEASIBLE';

  const allocationFreeBatches =
    perCell.length > 0 &&
    perCell.every((cell) => cell.perRepetition.every((item) => item.batchAllocations === 0));
  const allocationFreeAdmission = reps.every((rep) =>
    rep.admission.every((cell) => cell.paths.every((path) => path.allocations === 0)),
  );

  return {
    admission,
    fallbackRates,
    seriesFallback,
    timedFastShare,
    perCell,
    fits,
    linearity,
    estimates,
    ratios,
    checks,
    // E5, labelled: `inlineBytes` is size_of::<FillEngine>(); `admissionHeapBytes` the
    // admission engine's heap_bytes() (workspace, scratch and ladder, from FILL_V0_LIMITS);
    // `cellHeapBytes` the same from every prepared decision-cell engine (it must be one value);
    // `maxBufferBytes` the largest input plus output buffer a prepared cell engine held.
    engine: reps[0]
      ? {
          inlineBytes: reps[0].engine.inlineBytes,
          admissionHeapBytes: reps[0].engine.heapBytes,
          cellHeapBytes: [
            ...new Set(reps.flatMap((rep) => rep.cells.map((cell) => cell.heapBytes))),
          ],
          maxBufferBytes: reps
            .flatMap((rep) => rep.cells.map((cell) => cell.bufferBytes))
            .reduce((most, value) => Math.max(most, value), 0),
        }
      : null,
    oracle,
    allocationFreeBatches,
    allocationFreeAdmission,
    storageStable,
    failures: record.failures ?? [],
    invalidReasons,
    verdict,
    verdictLabel: `provisional at k = ${decision.wasmFactor}`,
  };
}

export type LadderAnalysis = ReturnType<typeof analyze>;

/** Rejects a record whose identity, configuration, hash or stored analysis differs. */
export function validateLadderRecord(record: LadderRecord): void {
  if (record.schemaVersion !== LADDER_SCHEMA_VERSION) throw new Error('unsupported schema version');
  if (
    record.scenario.id !== LADDER_SCENARIO_ID ||
    record.scenario.version !== LADDER_SCENARIO_VERSION
  )
    throw new Error('scenario identity mismatch');
  if (configHash(record.scenario.config) !== record.scenario.configHash)
    throw new Error('configuration hash mismatch');
  // The configuration is pinned: it must be this module's for the record's profile.
  if (
    canonicalJson(record.scenario.config) !== canonicalJson(scenarioConfig(record.scenario.profile))
  )
    throw new Error('configuration differs from scenarioConfig');
  if (record.corpus.sha256 !== CORPUS_SHA256) throw new Error('corpus hash mismatch');
  if (canonicalJson(analyze(record)) !== canonicalJson(record.analysis))
    throw new Error('stored analysis differs from the recomputation');
}

// ------------------------------------------------------------------------------------------
// The product stage (section 5.3): k = k̂ from AL-S2.

/** T̂ and t̂_edit with k = k̂, and t̂_p95 · k̂₁ as context; M̂ from AL-S1. */
export function productEstimates(
  analysis: Pick<LadderAnalysis, 'estimates'>,
  kHat: number,
  kHatOnePath: number | null = null,
  workloadPaths = b0ScenarioConfig('reference').decision.workloadPaths,
) {
  const estimates = analysis.estimates;
  if (estimates === null || !Number.isFinite(kHat) || kHat <= 0) return null;
  return {
    kHat,
    initialMs: (workloadPaths * estimates.perPathNs * kHat) / 1e6,
    editMs: (estimates.p95Ns * kHat) / 1e6,
    meshBytes: estimates.meshBytes,
    editOnePathContextMs: kHatOnePath === null ? null : (estimates.p95Ns * kHatOnePath) / 1e6,
  };
}

/**
 * The product verdict of section 5.3 under B0's unchanged rule with k = k̂: `NONE` for a
 * non-reference AL-S1 profile; no verdict (`INVALID`) when an oracle gate, a checksum mismatch
 * or `MESH_CHECK` invalidated AL-S1, or when AL-S2 reports `s2.invalid` (its browser checksum
 * differs from the native one, or another no-verdict cause); INCONCLUSIVE when any AL-S1
 * check or any other AL-S2 validity item fails; otherwise FEASIBLE or INFEASIBLE.
 */
export function productVerdict(
  analysis: Pick<LadderAnalysis, 'estimates' | 'checks' | 'invalidReasons' | 'verdict'>,
  kHat: number,
  s2: {
    /** A browser-vs-native checksum mismatch or another section 5.3 no-verdict cause. */
    readonly invalid: boolean;
    /** Every other AL-S2 validity item of section 5.2 holds. */
    readonly valid: boolean;
  },
  kHatOnePath: number | null = null,
) {
  const budgets = b0ScenarioConfig('reference').decision.budgets;
  const estimates = productEstimates(analysis, kHat, kHatOnePath);
  let verdict: Verdict;
  // B0's rule gives a non-reference profile no verdict.
  if (analysis.verdict === 'NONE') verdict = 'NONE';
  else if (analysis.invalidReasons.length > 0 || s2.invalid) verdict = 'INVALID';
  else if (!analysis.checks.every((item) => item.pass) || !s2.valid || estimates === null)
    verdict = 'INCONCLUSIVE';
  else
    verdict =
      estimates.initialMs <= budgets.initialMs &&
      estimates.editMs <= budgets.editMs &&
      estimates.meshBytes <= budgets.meshBytes
        ? 'FEASIBLE'
        : 'INFEASIBLE';
  return {
    verdict,
    estimates,
    ratios:
      estimates === null
        ? null
        : {
            initial: estimates.initialMs / budgets.initialMs,
            edit: estimates.editMs / budgets.editMs,
            mesh: estimates.meshBytes / budgets.meshBytes,
          },
  };
}

// ------------------------------------------------------------------------------------------
// The ratio mode's native analysis (section 5.2), for AL-S2.

export interface RatioCellOutput {
  readonly cell: string;
  readonly allocations: number;
  readonly storageStable: boolean;
  readonly sampleNs: readonly number[];
  readonly checksums: readonly string[];
}
export interface RatioOutput {
  readonly kind: 'ratio';
  readonly repetition: number;
  readonly revision: number;
  readonly clockQuantumNs: number;
  readonly calls: number;
  readonly onePathCalls: number;
  readonly order: readonly string[];
  readonly cells: readonly RatioCellOutput[];
  readonly onePath: readonly RatioCellOutput[];
}

/**
 * Per cell and repetition the native per-path median (median sample / (calls · paths)), its
 * UNVERIFIED flag, and the cell's checksum; then the validity items the native leg owns:
 * complete repetitions and cells, the revision, no allocation or storage change, one checksum
 * per cell across samples and repetitions, and no UNVERIFIED largest primary cell.
 */
export function analyzeRatioNative(
  outputs: readonly RatioOutput[],
  config: ReturnType<typeof ratioModeConfig>,
  cells: readonly CellSpec[] = corpusCells(),
) {
  const decision = cells.filter((cell) => cell.role === 'decision').map((cell) => cell.id);
  const quantumMultiple = b0ScenarioConfig('reference').decision.quantumMultiple;
  const reps = [...outputs].sort((left, right) => left.repetition - right.repetition);
  const issues: string[] = [];
  const table = (
    ids: readonly string[],
    pick: (output: RatioOutput) => readonly RatioCellOutput[],
    calls: number,
    paths: number,
  ) =>
    ids.map((id) => {
      const checksums = new Set<string>();
      const perRepetition = reps.flatMap((rep) => {
        const entry = pick(rep).find((item) => item.cell === id);
        if (!entry || entry.sampleNs.length === 0) {
          issues.push(`r${rep.repetition}:${id} missing`);
          return [];
        }
        entry.checksums.forEach((value) => checksums.add(value));
        if (entry.allocations !== 0) issues.push(`r${rep.repetition}:${id} allocates`);
        if (!entry.storageStable) issues.push(`r${rep.repetition}:${id} storage moved`);
        return [
          {
            repetition: rep.repetition,
            perPathMedianNs: median(entry.sampleNs) / (calls * paths),
            unverified: entry.sampleNs.some((ns) => ns < quantumMultiple * rep.clockQuantumNs),
          },
        ];
      });
      if (checksums.size !== 1) issues.push(`${id} checksums ${checksums.size}`);
      return {
        cell: id,
        checksum: checksums.size === 1 ? [...checksums][0]! : null,
        perRepetition,
      };
    });
  const tenPath = table(decision, (output) => output.cells, config.calls, DECISION_PATHS);
  const onePath = table(config.onePath.cells, (output) => output.onePath, config.onePath.calls, 1);
  if (reps.length !== config.sampling.repetitions)
    issues.push(`${reps.length} of ${config.sampling.repetitions} repetitions`);
  for (const rep of reps) {
    if (rep.revision !== OPERATION_REVISION) issues.push(`r${rep.repetition} revision`);
    if (rep.calls !== config.calls || rep.onePathCalls !== config.onePath.calls)
      issues.push(`r${rep.repetition} call counts`);
  }
  const unverifiedLargest = config.onePath.cells.filter((id) =>
    tenPath.find((item) => item.cell === id)?.perRepetition.some((item) => item.unverified),
  );
  if (unverifiedLargest.length > 0) issues.push(`UNVERIFIED ${unverifiedLargest.join(', ')}`);
  return { tenPath, onePath, issues, valid: issues.length === 0 };
}
