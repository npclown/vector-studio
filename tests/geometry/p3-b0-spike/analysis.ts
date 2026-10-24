/**
 * P3 B0 spike, unit SL-U3 (`docs/plans/p3-b0-spike-ladder-contract.md` section 5): the scenario
 * configuration, the oracle-run evaluation (sections 4 and 5.9), and the aggregates, fits,
 * estimates, checks, fallback tables and verdict of a spike record (sections 5.4-5.8 and 6).
 *
 * The fits and summaries are B0's own exported functions, imported unchanged from
 * `tests/geometry/p3-b0/analysis.ts` (section 5.6), and the corpus, cells, sampling, budgets
 * and decision constants come from B0's unchanged `scenarioConfig`. The oracles are SL-U2's
 * `oracle.ts`. The runner stores `analyze(record)` in the record; `validateSpikeRecord`
 * recomputes it and rejects a record whose stored values differ (section 5.12).
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
  type AdmissionCell,
  type B0Record,
  type Classification,
  type Fit,
  validateRecord,
} from '../p3-b0/analysis.js';
import {
  scenarioConfig as b0ScenarioConfig,
  type CellSpec,
  type Profile,
} from '../p3-b0/corpus.js';
import {
  absolute,
  compare,
  fromBits,
  rational,
  sub,
  toNumber,
  type Rational,
} from '../rounded-fill/exact.js';
import {
  exactHex,
  exactPoint,
  judgeRung,
  sliverStatistics,
  verifyAgreement,
  verifyCertificate,
  verifyRegionMesh,
  type Reason,
  type SpikeEntry,
  type SpikeMesh,
  type SpikeView,
} from './oracle.js';

export const SPIKE_SCENARIO_ID = 'p3-b0-spike-ladder';
export const SPIKE_SCENARIO_VERSION = 1;
export const SPIKE_RUNNER_VERSION = 'p3-b0-spike-runner/1';
export const SPIKE_SCHEMA_VERSION = 1;
/** Section 5.2: the B0 corpus bytes, as both B0 records pin them. */
export const CORPUS_SHA256 = '206cf6e9971d5f38f11cbef801692555843b1602ee937c5e1b60ed7dbd329796';
/** The unchanged B0 v1 reference configuration hash (SL-A3). */
export const B0_REFERENCE_CONFIG_HASH =
  'a10c98e9c732929b2752a7349486cbd95e31cc02018d3c703011543483d29271';
/** Section 4.4: the record whose exact-rung values SL-O4 reproduces. */
export const B0_IDENTITY_RECORD =
  'docs/benchmarks/results/2026-10-17_p3_p3-b0-feasibility-v1_native_desktop-dkvusav_20261017T150336Z-23973138.json';

/** Section 2.6, in stage order. */
export const REASONS: readonly Reason[] = [
  'PREFIX',
  'STRUCTURE',
  'DEVIATION',
  'CLOSURE',
  'MONOTONE',
  'CROSSING',
  'CLEARANCE',
  'TRIANGLE',
];
export const ORACLE_GATES = ['SL-O1', 'SL-O2', 'SL-O3', 'SL-O4'] as const;
export type OracleGate = (typeof ORACLE_GATES)[number];

const DECISION_PATHS = 10;
const LINEARITY_PATHS = 100;
const LINEARITY_CELL = 'P4/s=16';
/** δ = 0.125 and τ = 0.0625 (section 1), exactly. */
const DELTA = rational(1n, 8n);
const TAU = rational(1n, 16n);

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

/** Section 5.5: B0's sampling, without B0's H1 replay; the spike's diagnostic stops instead. */
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
    diagnostic: b0.diagnostic ? { warmup: b0.diagnostic.warmup, timed: b0.diagnostic.timed } : null,
  };
}

/** The configuration of section 5.1; its canonical JSON is hashed as in B0 section 7. */
export function scenarioConfig(profile: Profile) {
  const b0 = b0ScenarioConfig(profile);
  const sample = sampling(profile);
  return {
    scenario: { id: SPIKE_SCENARIO_ID, version: SPIKE_SCENARIO_VERSION },
    profile,
    runner: SPIKE_RUNNER_VERSION,
    reuses: { scenario: b0.scenario, referenceConfigHash: B0_REFERENCE_CONFIG_HASH },
    generator: b0.generator,
    corpus: { sha256: CORPUS_SHA256, encoder: 'tests/geometry/p3-b0/corpus.ts encodeCorpus' },
    cells: b0.cells,
    tolerances: { delta: 0.125, clearanceRadius: 0.25, tau: 0.0625 },
    fillRule: 'nonzero',
    rungs: {
      fast: 'p3_b0_spike::FastRung FR1-FR8 on the S1 view of CubicFillWorkspace::prepare_for_spike',
      exact: {
        decision: 'CubicFillWorkspace::attempt (Legacy topology)',
        o1: 'CubicFillWorkspace::attempt (Legacy topology)',
        x: 'CubicFillWorkspace::attempt_transverse',
      },
      limits: b0.kernel.limits,
      commandCapacity: 'cubic_fill::MAX_FLAT_COMMANDS',
    },
    fastRung: {
      stages: ['FR1', 'FR2', 'FR3', 'FR4', 'FR5', 'FR6', 'FR7', 'FR8'],
      reasons: REASONS,
    },
    oracles: [
      { id: 'SL-O1', status: 'gate', what: 'exact certificate re-verification' },
      { id: 'SL-O2', status: 'gate', what: 'exact region and mesh validity' },
      { id: 'SL-O3', status: 'gate', what: 'same input polygon and exact area band' },
      { id: 'SL-O4', status: 'gate', what: 'exact rung reproduces the 2026-10-17 record' },
      { id: 'SL-O5', status: 'observation', what: 'sliver statistics per cell and rung' },
      { id: 'SL-O6', status: 'observation', what: 'geometric error shares' },
      { id: 'SL-O7', status: 'observation', what: 'O1 and O2 admission' },
    ],
    oracleRun: {
      paths:
        'every corpus path: 0-9 per decision cell, 0-99 of P4/s=16, 0-29 per O1 cell, every X path',
      identityRecord: B0_IDENTITY_RECORD,
    },
    admission: {
      decisionPaths: DECISION_PATHS,
      linearityPaths: LINEARITY_PATHS,
      okRule: 'the ladder publishes a nonempty mesh (fast rung, or exact rung on fallback)',
      capCodes: b0.admission.capCodes,
    },
    sampling: sample,
    checksum:
      'FNV-1a 64 per batch over the rung as u32 LE (0 fast, 1 exact), V and T as u32 LE, vertex x and y f64 bits LE, indices u32 LE',
    aggregation: b0.aggregation,
    order: b0.order,
    diagnostic: sample.diagnostic
      ? {
          stops: [
            { id: 'SL-D1', through: 'S1 prefix' },
            { id: 'SL-D2', through: 'FR5 (certificate)' },
            { id: 'SL-D3', through: 'FR6 (classification)' },
            { id: 'SL-D4', through: 'FR8 (full fast rung)' },
          ],
          timing: 'the fast rung alone, with its own S1 prefix; no exact rung on a fallback',
          cells: 'P2, P4 and P8',
          warmup: sample.diagnostic.warmup,
          timed: sample.diagnostic.timed,
          exactBaseline: true,
          filters: ['F0.2', 'F1', 'F0.3'],
        }
      : null,
    fits: {
      ...b0.fits,
      seriesRoles: { primary: b0.decision.primarySeries, observational: ['K2', 'K4'] },
    },
    decision: b0.decision,
    checks: CHECK_IDS,
  };
}

export type SpikeConfig = ReturnType<typeof scenarioConfig>;

// ------------------------------------------------------------------------------------------
// Record types.

export interface SpikeAdmissionPath {
  readonly status: string;
  readonly rung: 'fast' | 'exact';
  readonly reason: Reason | null;
  readonly flatCommands?: number;
  readonly vertices?: number;
  readonly triangles?: number;
  readonly rounded: boolean;
  readonly transverse: boolean;
  readonly allocations: number;
}
export interface SpikeAdmissionCell {
  readonly cell: string;
  readonly paths: readonly SpikeAdmissionPath[];
}
export interface SpikeDecisionOutput {
  readonly kind: 'decision';
  readonly repetition: number;
  readonly clockQuantumNs: number;
  readonly workspace: { readonly inlineBytes: number; readonly allocatedBytes: number };
  readonly admission: readonly SpikeAdmissionCell[];
  readonly order: readonly string[];
  readonly cells: readonly {
    readonly cell: string;
    readonly workspaceNs: number;
    readonly batchAllocations: number;
    readonly batchNs: readonly number[];
    readonly pathNs: readonly number[];
    readonly checksums: readonly string[];
  }[];
  readonly linearity: {
    readonly cell: string;
    readonly batch10Ns: readonly number[];
    readonly checksums10: readonly string[];
    readonly batch100Ns: readonly number[];
    readonly checksums100: readonly string[];
  } | null;
}
export interface SpikeDiagnosticOutput {
  readonly kind: 'diagnostic';
  readonly clockQuantumNs: number;
  readonly stages: readonly {
    readonly cell: string;
    readonly d1Ns: readonly number[];
    readonly d2Ns: readonly number[];
    readonly d3Ns: readonly number[];
    readonly d4Ns: readonly number[];
    readonly exactNs: readonly number[];
    readonly fallbacks: Readonly<Record<'d1Ns' | 'd2Ns' | 'd3Ns' | 'd4Ns', number>>;
    readonly counts: readonly {
      readonly rung: 'fast' | 'exact';
      readonly sweepCandidates: number;
      readonly clearanceStep2: number;
      readonly clearanceStep3: number;
      readonly diagonals: number;
      readonly filters: readonly { filter: string; decided: number; fallback: number }[];
    }[];
  }[];
}
/** The Rust side of the oracle run (`run_spike_oracle`), without the dump. */
export interface OracleHarnessOutput {
  readonly kind: 'oracle';
  readonly ladderCalls: number;
  readonly allocatingCalls: readonly string[];
  readonly s1Accessor: {
    readonly published: number;
    readonly other: number;
    readonly failures: readonly string[];
  };
  readonly exactChecksums: readonly {
    readonly cell: string;
    readonly checksum10: string | null;
    readonly checksum100?: string | null;
  }[];
}
/** One path of the oracle dump (`p3-b0-spike-dump/1`). */
export interface DumpPath {
  readonly cell: string;
  readonly path: number;
  readonly rung: 'fast' | 'exact';
  readonly reason: Reason | null;
  readonly ladderStatus: string;
  readonly allocations: number;
  readonly fastMesh: SpikeMesh | null;
  readonly maxDeviationSquared: string | null;
  readonly exact: {
    readonly status: string;
    readonly flatCommands?: number;
    readonly vertices?: number;
    readonly triangles?: number;
    readonly rounded: boolean;
    readonly transverse: boolean;
    readonly published: SpikeView | null;
    readonly mesh: SpikeMesh | null;
  };
  readonly view: SpikeView | null;
  readonly flatCommands?: number;
  readonly prefixFailure?: string;
}
export interface OracleDump {
  readonly schema: 'p3-b0-spike-dump/1';
  readonly paths: readonly DumpPath[];
}

export interface SliverAggregate {
  readonly cell: string;
  readonly rung: 'fast' | 'exact';
  readonly meshes: number;
  readonly triangles: number;
  readonly quality: { readonly min: number; readonly p5: number; readonly median: number } | null;
  readonly angle: { readonly min: number; readonly p5: number; readonly median: number } | null;
  readonly below01: number;
  readonly below001: number;
  readonly minAltitude: number | null;
}

/** The evaluated oracle run, stored in the record (section 5.9). */
export interface OracleResults {
  readonly dump: { readonly sha256: string; readonly bytes: number; readonly paths: number };
  readonly harness: {
    readonly ladderCalls: number;
    readonly allocatingCalls: readonly string[];
    readonly s1Accessor: OracleHarnessOutput['s1Accessor'];
  };
  readonly gates: Readonly<
    Record<OracleGate, { readonly checked: number; readonly failures: readonly string[] }>
  >;
  /** Per cell: the ladder mix of the oracle run, SL-O1 classifications and SL-O3 sizes. */
  readonly cells: readonly {
    readonly cell: string;
    readonly paths: number;
    readonly fast: number;
    readonly fallbacks: Readonly<Partial<Record<Reason, number>>>;
    readonly conservative: number;
    readonly reasonClass: Readonly<Record<string, number>>;
    readonly exactOk: number;
    readonly bothAdmitted: number;
    readonly exactChainMatches: number;
    readonly fastMeshSize: { readonly vertices: number; readonly triangles: number };
    readonly exactMeshSize: { readonly vertices: number; readonly triangles: number };
  }[];
  readonly slivers: readonly SliverAggregate[];
  readonly geometricError: readonly {
    readonly cell: string;
    readonly fastPaths: number;
    readonly maxCertifiedDeviation: number | null;
    readonly maxExactDeviation: number | null;
    readonly topologyShare: 0 | null;
    readonly contractedContours: number;
    readonly maxContractedKnotGap: number | null;
  }[];
  readonly o1: readonly {
    readonly cell: string;
    readonly fast: number;
    readonly fallbacks: Readonly<Partial<Record<Reason, number>>>;
    readonly conservative: number;
    readonly exactOk: number;
    readonly referenceExactOk: number;
  }[];
  readonly o2: readonly {
    readonly cell: string;
    readonly paths: number;
    readonly crossing: number;
    readonly exactUnresolved: number;
    readonly asExpected: boolean;
  }[];
  readonly checksums: readonly {
    readonly cell: string;
    readonly checksum10: string | null;
    readonly reference10: string | null;
    readonly checksum100?: string | null;
    readonly reference100?: string | null;
  }[];
}

export interface SpikeRecord {
  readonly schemaVersion: 1;
  readonly scenario: {
    readonly id: string;
    readonly version: number;
    readonly profile: Profile;
    readonly config: SpikeConfig;
    readonly configHash: string;
  };
  readonly run: Record<string, unknown>;
  readonly environment: Record<string, unknown>;
  readonly builds: Record<string, unknown>;
  readonly corpus: { readonly sha256: string; readonly bytes: number };
  readonly repetitions: readonly SpikeDecisionOutput[];
  readonly diagnostic: SpikeDiagnosticOutput | null;
  readonly oracle: OracleResults | null;
  readonly failures?: readonly { stage: string; error: string; log: string }[];
  readonly analysis?: unknown;
}

// ------------------------------------------------------------------------------------------
// The oracle run (sections 4 and 5.9).

function pathName(path: Pick<DumpPath, 'cell' | 'path'>): string {
  return `${path.cell}#${path.path}`;
}

function roleOf(cell: string): 'decision' | 'o1' | 'o2' {
  return cell.startsWith('O1/') ? 'o1' : cell.startsWith('X/') ? 'o2' : 'decision';
}

function sliverAggregate(
  cell: string,
  rung: 'fast' | 'exact',
  meshes: readonly SpikeMesh[],
): SliverAggregate {
  const values = meshes.flatMap((mesh) => sliverStatistics(mesh).perTriangle);
  if (values.length === 0)
    return {
      cell,
      rung,
      meshes: meshes.length,
      triangles: 0,
      quality: null,
      angle: null,
      below01: 0,
      below001: 0,
      minAltitude: null,
    };
  const summary = (items: readonly number[]) => {
    const sorted = [...items].sort((left, right) => left - right);
    return { min: sorted[0]!, p5: nearestRank(sorted, 0.05), median: nearestRank(sorted, 0.5) };
  };
  const qualities = values.map((value) => value.quality);
  return {
    cell,
    rung,
    meshes: meshes.length,
    triangles: values.length,
    quality: summary(qualities),
    angle: summary(values.map((value) => value.angle)),
    below01: qualities.filter((value) => value < 0.1).length,
    below001: qualities.filter((value) => value < 0.01).length,
    minAltitude: values.reduce((least, value) => Math.min(least, value.altitude), Infinity),
  };
}

/**
 * SL-O4 amendment, 2026-10-24 (E8-U2, docs/evidence/e8-u2-2026-10-24.md): the exact rung's
 * canonical source-final knot may turn a recorded KnotMismatch, or the OwnerLimit it can cause,
 * into OK (757 B0 O1 paths: 741 and 16). Every recorded OK outcome, every other recorded
 * failure, and every failure that stays a failure must still equal the record.
 */
export function e8U2FailureToSuccess(recorded: string, exact: string): boolean {
  return (recorded === 'Topology(KnotMismatch)' || recorded === 'OwnerLimit') && exact === 'OK';
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

/**
 * Applies SL-O1 to SL-O7 to the oracle dump (section 5.9). Pure: the runner passes the parsed
 * dump, the harness output, the dump's hash and size, and the 2026-10-17 B0 record.
 */
export function evaluateOracle(
  dump: OracleDump,
  harness: OracleHarnessOutput,
  dumpIdentity: { sha256: string; bytes: number },
  reference: B0Record,
  expected: readonly { readonly id: string; readonly paths: number }[] = b0ScenarioConfig(
    'reference',
  ).cells,
): OracleResults {
  if (dump.schema !== 'p3-b0-spike-dump/1') throw new Error('unsupported oracle dump schema');
  const gates: Record<OracleGate, { checked: number; failures: string[] }> = {
    'SL-O1': { checked: 0, failures: [] },
    'SL-O2': { checked: 0, failures: [] },
    'SL-O3': { checked: 0, failures: [] },
    'SL-O4': { checked: 0, failures: [] },
  };
  const fail = (gate: OracleGate, path: DumpPath | null, detail: string) =>
    gates[gate].failures.push(path ? `${pathName(path)}: ${detail}` : detail);

  // SL-O4 premise: the identity record is the unchanged B0 v1 reference run. Its configuration
  // hash is recomputed and B0's own validator recomputes its stored analysis.
  if (configHash(reference.scenario.config) !== B0_REFERENCE_CONFIG_HASH)
    fail('SL-O4', null, 'identity record configuration hash differs');
  try {
    validateRecord(reference);
  } catch (error) {
    fail('SL-O4', null, `identity record rejected by B0's validator: ${(error as Error).message}`);
  }
  if (reference.corpus.sha256 !== CORPUS_SHA256)
    fail('SL-O4', null, 'identity record corpus hash differs');
  const referenceOutcomes = new Map<string, AdmissionCell>();
  for (const cell of reference.repetitions[0]?.admission ?? [])
    referenceOutcomes.set(cell.cell, cell);
  for (const cell of reference.diagnostic?.observations ?? [])
    referenceOutcomes.set(cell.cell, cell);

  const byCell = new Map<string, DumpPath[]>();
  for (const path of dump.paths) {
    const list = byCell.get(path.cell) ?? [];
    list.push(path);
    byCell.set(path.cell, list);
  }

  const cells: OracleResults['cells'][number][] = [];
  const slivers: SliverAggregate[] = [];
  const geometricError: OracleResults['geometricError'][number][] = [];
  const o1: OracleResults['o1'][number][] = [];
  const o2: OracleResults['o2'][number][] = [];
  for (const [cell, paths] of byCell) {
    const fallbacks: Partial<Record<Reason, number>> = {};
    const reasonClass: Record<string, number> = {};
    let fast = 0;
    let conservative = 0;
    let exactOk = 0;
    let bothAdmitted = 0;
    let exactChainMatches = 0;
    const fastSize = { vertices: 0, triangles: 0 };
    const exactSize = { vertices: 0, triangles: 0 };
    const fastMeshes: SpikeMesh[] = [];
    const exactMeshes: SpikeMesh[] = [];
    let maxCertified: number | null = null;
    let maxExact: Rational | null = null;
    let topologyOk = true;
    let contracted = 0;
    let maxGap: number | null = null;
    const reference = referenceOutcomes.get(cell);
    for (const path of paths) {
      if (path.rung === 'fast') fast += 1;
      else if (path.reason) fallbacks[path.reason] = (fallbacks[path.reason] ?? 0) + 1;
      if (path.exact.status === 'OK') exactOk += 1;
      if (path.exact.mesh) exactMeshes.push(path.exact.mesh);
      // SL-O4: the exact rung's outcome equals the record's (status, sizes, topology mix).
      gates['SL-O4'].checked += 1;
      const expected = reference?.paths[path.path];
      if (!expected) fail('SL-O4', path, 'no outcome in the identity record');
      else if (
        outcomeKey(path.exact) !== outcomeKey(expected) &&
        !e8U2FailureToSuccess(expected.status, path.exact.status)
      )
        fail('SL-O4', path, `exact ${outcomeKey(path.exact)} != record ${outcomeKey(expected)}`);
      // The ladder's own output agrees with its rung (section 2.1).
      if (path.rung === 'exact' && path.ladderStatus !== path.exact.status)
        fail('SL-O4', path, 'fallback status differs from the exact rung run alone');

      // SL-O1: the exact certificate on every path with an S1 view.
      if (path.view !== null && !(path.rung === 'exact' && path.reason === 'PREFIX')) {
        gates['SL-O1'].checked += 1;
        try {
          const certificate = verifyCertificate(path.view, DELTA);
          const judgement = judgeRung(
            {
              ...path.view,
              rung: path.rung === 'fast' ? 'fast' : 'fallback',
              reason: path.reason,
              stop: 'Fr8',
            } as unknown as SpikeEntry,
            certificate,
          );
          if (judgement.unsound.length > 0)
            fail('SL-O1', path, `passed but exactly false: ${judgement.unsound.join(', ')}`);
          if (judgement.conservative === true) conservative += 1;
          if (judgement.reason !== null)
            reasonClass[judgement.reason] = (reasonClass[judgement.reason] ?? 0) + 1;
          if (path.rung === 'fast') {
            const exactMax = certificate.maxDeviationSquared;
            if (exactMax === null || path.maxDeviationSquared === null)
              fail('SL-O1', path, 'no deviation bound');
            else {
              const certified = exactHex(path.maxDeviationSquared);
              if (compare(exactMax, certified) > 0)
                fail('SL-O1', path, 'certified deviation bound below the exact value');
              const certifiedValue = Math.sqrt(fromBits(BigInt(`0x${path.maxDeviationSquared}`)));
              maxCertified =
                maxCertified === null ? certifiedValue : Math.max(maxCertified, certifiedValue);
              if (maxExact === null || compare(exactMax, maxExact) > 0) maxExact = exactMax;
            }
            for (const [contour, closure] of certificate.closures.entries()) {
              if (closure !== 'degenerate-source-close') continue;
              contracted += 1;
              const [start, count] = path.view.ranges[contour]!;
              const m = exactPoint(path.view.points[start]!);
              const k = exactPoint(path.view.points[start + count - 1]!);
              const gap = Math.hypot(
                toNumber(absolute(sub(k.x, m.x))),
                toNumber(absolute(sub(k.y, m.y))),
              );
              maxGap = maxGap === null ? gap : Math.max(maxGap, gap);
            }
          }
        } catch (error) {
          fail('SL-O1', path, `oracle error ${(error as Error).message}`);
        }
      }
      if (path.rung !== 'fast') continue;

      // SL-O2: the fast mesh against the exact region R(P).
      gates['SL-O2'].checked += 1;
      if (path.view === null || path.fastMesh === null) {
        fail('SL-O2', path, 'fast path without view or mesh');
        topologyOk = false;
        continue;
      }
      fastMeshes.push(path.fastMesh);
      fastSize.vertices += path.fastMesh.vertices.length;
      fastSize.triangles += path.fastMesh.triangles.length;
      const region = verifyRegionMesh(path.view, 'nonzero', path.fastMesh);
      if (!region.ok) {
        topologyOk = false;
        fail('SL-O2', path, region.issues.slice(0, 3).join('; '));
      }

      // SL-O3: on paths both rungs admit, the same input polygon and the exact area band.
      if (path.exact.status === 'OK' && path.exact.published && path.exact.mesh) {
        bothAdmitted += 1;
        gates['SL-O3'].checked += 1;
        exactSize.vertices += path.exact.mesh.vertices.length;
        exactSize.triangles += path.exact.mesh.triangles.length;
        const agreement = verifyAgreement(
          path.view,
          'nonzero',
          { ...path.exact.published, mesh: path.exact.mesh },
          TAU,
        );
        if (!agreement.samePolygon) fail('SL-O3', path, 'exact polygon differs from the S1 view');
        if (!agreement.withinBand) fail('SL-O3', path, 'exact mesh area outside the τ band');
        if (agreement.exactMesh.chainMatches) exactChainMatches += 1;
      }
    }
    cells.push({
      cell,
      paths: paths.length,
      fast,
      fallbacks,
      conservative,
      reasonClass,
      exactOk,
      bothAdmitted,
      exactChainMatches,
      fastMeshSize: fastSize,
      exactMeshSize: exactSize,
    });
    slivers.push(sliverAggregate(cell, 'fast', fastMeshes));
    slivers.push(sliverAggregate(cell, 'exact', exactMeshes));
    geometricError.push({
      cell,
      fastPaths: fast,
      maxCertifiedDeviation: maxCertified,
      maxExactDeviation: maxExact === null ? null : Math.sqrt(toNumber(maxExact)),
      topologyShare: fast > 0 && topologyOk ? 0 : null,
      contractedContours: contracted,
      maxContractedKnotGap: maxGap,
    });
    if (roleOf(cell) === 'o1')
      o1.push({
        cell,
        fast,
        fallbacks,
        conservative,
        exactOk,
        referenceExactOk: reference?.paths.filter((item) => item.status === 'OK').length ?? 0,
      });
    if (roleOf(cell) === 'o2') {
      const crossing = paths.filter((path) => path.reason === 'CROSSING').length;
      const unresolved = paths.filter(
        (path) => path.exact.status === 'Topology(Unresolved)',
      ).length;
      o2.push({
        cell,
        paths: paths.length,
        crossing,
        exactUnresolved: unresolved,
        asExpected: crossing === paths.length && unresolved === paths.length,
      });
    }
  }

  // SL-O4: the exact rung's B0 batch checksums equal the record's.
  const checksums = harness.exactChecksums.map((entry) => {
    gates['SL-O4'].checked += 1;
    const reference10 = referenceChecksum(reference, entry.cell, false);
    if (entry.checksum10 === null || entry.checksum10 !== reference10)
      fail('SL-O4', null, `${entry.cell}: checksum ${entry.checksum10} != record ${reference10}`);
    if (entry.checksum100 === undefined)
      return { cell: entry.cell, checksum10: entry.checksum10, reference10 };
    gates['SL-O4'].checked += 1;
    const reference100 = referenceChecksum(reference, entry.cell, true);
    if (entry.checksum100 === null || entry.checksum100 !== reference100)
      fail('SL-O4', null, `${entry.cell}: 100-path checksum differs from the record`);
    return {
      cell: entry.cell,
      checksum10: entry.checksum10,
      reference10,
      checksum100: entry.checksum100,
      reference100,
    };
  });
  const decisionCells = reference.scenario.config.cells.filter(
    (cell) => cell.role === 'decision',
  ).length;
  if (checksums.length !== decisionCells)
    fail('SL-O4', null, `${checksums.length} checksums for ${decisionCells} decision cells`);
  if (dump.paths.length !== harness.ladderCalls)
    fail('SL-O4', null, 'dump and harness path counts differ');
  // The dump is complete: every (cell, path) of the oracle list exactly once (section 4).
  const seen = new Map<string, number>();
  for (const path of dump.paths) seen.set(pathName(path), (seen.get(pathName(path)) ?? 0) + 1);
  let expectedPaths = 0;
  for (const cell of expected)
    for (let index = 0; index < cell.paths; index += 1) {
      expectedPaths += 1;
      const count = seen.get(`${cell.id}#${index}`) ?? 0;
      if (count !== 1) fail('SL-O4', null, `dump has ${cell.id}#${index} ${count} times`);
    }
  if (dump.paths.length !== expectedPaths)
    fail('SL-O4', null, `dump has ${dump.paths.length} paths for ${expectedPaths} expected`);

  return {
    dump: { ...dumpIdentity, paths: dump.paths.length },
    harness: {
      ladderCalls: harness.ladderCalls,
      allocatingCalls: harness.allocatingCalls,
      s1Accessor: harness.s1Accessor,
    },
    gates,
    cells,
    slivers,
    geometricError,
    o1,
    o2,
    checksums,
  };
}

/** Gate status recomputed from the stored failure lists (an empty gate does not pass). */
export function oracleStatus(oracle: OracleResults | null) {
  if (oracle === null)
    return {
      present: false,
      valid: false,
      gates: ORACLE_GATES.map((id) => ({ id, checked: 0, failures: 0, pass: false })),
      harness: { allocationFree: false, s1Accessor: false },
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
    gates,
    harness: {
      allocationFree: oracle.harness.ladderCalls > 0 && oracle.harness.allocatingCalls.length === 0,
      s1Accessor:
        oracle.harness.s1Accessor.published > 0 && oracle.harness.s1Accessor.failures.length === 0,
    },
  };
}

// ------------------------------------------------------------------------------------------
// Aggregates, fits, estimates, checks and verdict (sections 5.4-5.8 and 6).

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

/** The ladder mix of one admission cell: rung, reason and, on fallback, topology selection. */
function ladderMix(cell: SpikeAdmissionCell) {
  return {
    cell: cell.cell,
    paths: cell.paths.map((path) => ({ ...path, allocations: 0 })),
  };
}

function ladderTable(cell: SpikeAdmissionCell) {
  const fallbacks: Partial<Record<Reason, number>> = {};
  let fast = 0;
  for (const path of cell.paths) {
    if (path.rung === 'fast') fast += 1;
    else if (path.reason) fallbacks[path.reason] = (fallbacks[path.reason] ?? 0) + 1;
  }
  const paths = cell.paths.length;
  return { paths, fast, fallbacks, fallbackRate: paths === 0 ? null : (paths - fast) / paths };
}

function analyzeDiagnostic(diagnostic: SpikeDiagnosticOutput) {
  return diagnostic.stages.map((stage) => {
    const d1 = median(stage.d1Ns);
    const d2 = median(stage.d2Ns);
    const d3 = median(stage.d3Ns);
    const d4 = median(stage.d4Ns);
    const exact = median(stage.exactNs);
    const total = (key: 'sweepCandidates' | 'clearanceStep2' | 'clearanceStep3' | 'diagonals') =>
      stage.counts.reduce((sum, count) => sum + count[key], 0);
    const filters: Record<string, { decided: number; fallback: number }> = {};
    for (const count of stage.counts)
      for (const filter of count.filters) {
        const entry = (filters[filter.filter] ??= { decided: 0, fallback: 0 });
        entry.decided += filter.decided;
        entry.fallback += filter.fallback;
      }
    return {
      cell: stage.cell,
      batchMedianNs: { d1, d2, d3, d4, exact },
      stagesNs: {
        prefix: d1,
        certificate: d2 - d1,
        classification: d3 - d2,
        triangulation: d4 - d3,
        fastTotal: d4,
        exactAlone: exact,
      },
      exactOverFast: exact / d4,
      fallbacks: stage.fallbacks,
      perPath: {
        sweepCandidates: total('sweepCandidates') / stage.counts.length,
        clearanceStep2: total('clearanceStep2') / stage.counts.length,
        clearanceStep3: total('clearanceStep3') / stage.counts.length,
        diagonals: total('diagonals') / stage.counts.length,
      },
      filters,
    };
  });
}

export function analyze(record: SpikeRecord) {
  const config = record.scenario.config;
  const decision = config.decision;
  const cells = config.cells.filter((cell) => cell.role === 'decision');
  const specOf = new Map<string, CellSpec>(config.cells.map((cell) => [cell.id, cell]));
  const reps = [...record.repetitions].sort((left, right) => left.repetition - right.repetition);
  const checks: Check[] = [];
  const check = (id: string, pass: boolean, detail: string) => checks.push({ id, pass, detail });

  // Admission from repetition 0 (section 5.4), with B0's classification and code list.
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

  // Fallback-rate reporting (section 5.7): per decision cell and repetition.
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
          workspaceNs: timed.workspaceNs,
          batch: summarize(timed.batchNs.map((ns) => ns / DECISION_PATHS)),
          path: summarize(timed.pathNs),
        },
      ];
    });
    return { cell: spec.id, series: spec.series, leaves: leaves(spec), perRepetition };
  });

  // Fits (section 5.6), with B0's fitSeries.
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

  // B0's validity checks 1-8 (section 5.6), check 5 with the ladder mix as 5b.
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
      rep.cells.find((cell) => cell.cell === spec.id)?.checksums.forEach((sum) => sums.add(sum));
      if (rep.linearity && rep.linearity.cell === spec.id)
        rep.linearity.checksums10.forEach((sum) => sums.add(sum));
    }
    if (sums.size > 1) checksumIssues.push(spec.id);
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

  // Estimates (B0 section 5, unchanged).
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
  // Section 6, information for the user: the estimates as multiples of their budgets.
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
  // Sections 4 and 6: a failed oracle gate or a checksum mismatch invalidates the run, and so do
  // the oracle run's harness checks (an allocating ladder call, SL-A7; an S1 accessor mismatch,
  // section 2.2).
  const invalidReasons = [
    ...(oracle.valid ? [] : ['oracle gate']),
    ...(oracle.harness.allocationFree ? [] : ['allocating ladder call']),
    ...(oracle.harness.s1Accessor ? [] : ['S1 accessor mismatch']),
    ...(checksumsPass ? [] : ['checksum mismatch']),
  ];
  let verdict: 'NONE' | 'INVALID' | 'FEASIBLE' | 'INFEASIBLE' | 'INCONCLUSIVE';
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
    diagnostic: record.diagnostic ? analyzeDiagnostic(record.diagnostic) : null,
    oracle,
    allocationFreeBatches,
    allocationFreeAdmission,
    failures: record.failures ?? [],
    invalidReasons,
    verdict,
  };
}

/** Section 5.12: rejects a record whose stored hash or analysis differs from a recomputation. */
export function validateSpikeRecord(record: SpikeRecord): void {
  if (record.schemaVersion !== SPIKE_SCHEMA_VERSION) throw new Error('unsupported schema version');
  if (
    record.scenario.id !== SPIKE_SCENARIO_ID ||
    record.scenario.version !== SPIKE_SCENARIO_VERSION
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
