/**
 * P3 Alt-A1 AL-OB5 unit OB5-U2 (`docs/plans/p3-al-ob5-workload-scenario-proposal.md`
 * sections 3-5): scenario `p3-al-ob5-workload` v1, the direct measurement of the 1,000 횞 32
 * workload. The pinned configuration and its hash, the oracle-run evaluation (OB5-V7, OB5-V8),
 * the analysis of a record (the statistics of section 3.4, the validity items OB5-V1 to
 * OB5-V14 and the verdict of section 4), and the validator `validateOb5Record`.
 *
 * The browser leg decides; the native leg is report-only and is the browser oracle (OB5-V1)
 * and the source of the rung mix (OB5-V6). The fold is AL-S2's decoded fold, unchanged. The
 * budgets and the three-verdict rule are B0's and Alt-A1's, unchanged; the analysis only
 * replaces the extrapolated estimates by the measured T, t_edit and M.
 *
 * Erasable TypeScript only, so the Node runner can load it directly.
 */
import { canonicalJson, configHash, nearestRank } from '../p3-b0/analysis.js';
import {
  generateCellPaths,
  scenarioConfig as b0ScenarioConfig,
  type Profile,
} from '../p3-b0/corpus.js';
import { sliverStatistics, type SpikeMesh } from '../p3-b0-spike/oracle.js';
import { kernelSourceSha256, sha256Hex } from '../p3-b0-wasm/analysis.js';
import { DUMP_SCHEMA, type LadderDump, type LadderEntry } from '../p3-fill-ladder/dump.js';
import { type DumpInput } from '../p3-fill-ladder/corpus.js';
import {
  OPERATION_ID,
  OPERATION_REVISION,
  type LadderOracleHarness,
} from '../p3-fill-ladder/analysis.js';
import { evaluateEntry, powerOfTwo } from '../p3-fill-ladder/oracle.js';
import { div, type Rational } from '../rounded-fill/exact.js';
import {
  editOrder,
  EDIT_SEED,
  EDIT_WARMUP_PATHS,
  Fnv1a64,
  ORDER_SEED,
  setOrder,
  type Ob5Capture,
  type Ob5PageOptions,
  type Ob5Sample,
} from '../../geometry-benchmark/p3-al-ob5/workload.js';
import {
  encodeOb5DecisionCorpus,
  encodeOb5ObservationCorpus,
  ob5DecisionCells,
  ob5ExpectedCounts,
  ob5ObservationCells,
  OB5_CUBICS,
  OB5_PATHS,
  OB5_SCENARIO_ID,
  OB5_SCENARIO_VERSION,
} from './corpus.js';

export { OPERATION_ID, OPERATION_REVISION, sha256Hex, kernelSourceSha256 };
export const OB5_RUNNER_VERSION = 'p3-al-ob5-runner/1';
export const OB5_SCHEMA_VERSION = 1;
/** The decision corpus SHA-256 recorded with OB5-U1 (plan, "Alt-A1 AL-OB5 OB5-U1"). */
export const OB5_CORPUS_SHA256 = '353fef77a5f7fe9208bdd6566a16477833ea0dc47528dbaca8581a37222acc2f';
/** The OB5-Q7 (a) observation corpus SHA-256 recorded with OB5-U1. */
export const OB5_OBSERVATION_CORPUS_SHA256 =
  '8c6618bec379f5e1041ef5803913e16208427cbb178c784afa1238580b2596fc';
export const BROWSER_PROJECTS = ['chrome', 'edge'] as const;
export type BrowserProject = (typeof BROWSER_PROJECTS)[number];
export const VALIDITY_IDS = [
  'OB5-V1',
  'OB5-V2',
  'OB5-V3',
  'OB5-V4',
  'OB5-V5',
  'OB5-V6',
  'OB5-V7',
  'OB5-V8',
  'OB5-V9',
  'OB5-V10',
  'OB5-V11',
  'OB5-V12',
  'OB5-V13',
  'OB5-V14',
] as const;
export type ValidityId = (typeof VALIDITY_IDS)[number];
/** Section 4: the output-identity items; any failure gives INVALID (no verdict). */
export const IDENTITY_ITEMS: readonly ValidityId[] = [
  'OB5-V1',
  'OB5-V2',
  'OB5-V3',
  'OB5-V7',
  'OB5-V8',
];
export const ORACLE_GATES = ['SL-O1', 'SL-O2', 'SL-O3', 'AL-I2', 'harness'] as const;
export type OracleGate = (typeof ORACLE_GATES)[number];
/** Section 3.4: AL-U7's estimates, reported beside T and t_edit as context only. */
export const AL_U7_CONTEXT = Object.freeze({
  initialMs: 1031.1,
  editMs: 4.367,
  editOnePathMs: 4.467,
});
const MEMORY_CEILING_BYTES = 256 * 2 ** 20;
const ORACLE_FUNCTIONAL_PATHS = 10;
const STATUS_NAMES: readonly string[] = [
  'ok',
  'empty',
  'invalid-path',
  'invalid-tolerance',
  'numeric-range',
  'work-limit',
  'unsupported-geometry',
];

function sampling(profile: Profile) {
  const reference = profile === 'reference';
  return {
    repetitions: reference ? 5 : 1,
    initWarmup: reference ? 3 : 1,
    initTimed: reference ? 20 : 2,
    editPaths: reference ? OB5_PATHS : 100,
  };
}

/** The flat command count of a fast mesh's source at 貫 leaves per cubic (B0's check 6). */
function flatCommands(lambda: number): number {
  return OB5_CUBICS * lambda + 2;
}

/** The pinned configuration of sections 2-5; its canonical JSON is hashed as in B0 section 7. */
export function scenarioConfig(profile: Profile) {
  const b0 = b0ScenarioConfig(profile);
  const sample = sampling(profile);
  const cells = ob5DecisionCells();
  return {
    scenario: { id: OB5_SCENARIO_ID, version: OB5_SCENARIO_VERSION },
    runner: OB5_RUNNER_VERSION,
    profile,
    corpus: {
      id: 'p3-al-ob5-workload/v1',
      generator:
        'p3-b0-ring/v1, generateCellPaths and encodeCorpus of tests/geometry/p3-b0/corpus.ts, unchanged',
      encoder: 'tests/geometry/p3-al-ob5/corpus.ts encodeOb5DecisionCorpus',
      sha256: OB5_CORPUS_SHA256,
      cells,
      bytes:
        'the TypeScript-encoded bytes; the page verifies the SHA-256, the native leg reads the same file and reports its FNV-1a 64',
    },
    observation: {
      question: 'OB5-Q7 (a)',
      cells: ob5ObservationCells(),
      sha256: OB5_OBSERVATION_CORPUS_SHA256,
      what: 'native and untimed, on the TypeScript-encoded bytes: batch status, per-path status and rung mix; outside the verdict',
      harness: 'p3_al_ob5_bench::run_ob5_observation',
    },
    requests: { fillRule: 'nonzero', toleranceExponent: -3, requestId: 'the path index' },
    operation: {
      id: OPERATION_ID,
      revision: OPERATION_REVISION,
      portVersion: 0,
      transportVersion: 0,
      port: 'createFillMeshPort(WebAssembly.Module) of packages/geometry-wasm, one adapter per page',
      wasm: 'release wasm32-unknown-unknown build of the kernel, SHA-256 verified in the page',
      native:
        'FillEngine::process at the production caps (FILL_V0_LIMITS, no pre-B1 hook), release libtest harness, single thread',
    },
    browser: {
      projects: BROWSER_PROJECTS,
      channels: { chrome: 'chrome', edge: 'msedge' },
      order:
        'native leg, then Chrome, then Edge, then the observation and the oracle run, in one runner session',
      headed: true,
      workers: 1,
      freshPagePerRepetition: true,
      devtools: false,
      tracing: false,
      video: false,
      viewport: { width: 1280, height: 720, deviceScaleFactor: 1 },
      crossOriginIsolated: true,
      page: 'Vite production build of tests/geometry-benchmark/p3-al-ob5',
    },
    sampling: {
      repetitions: sample.repetitions,
      nativeRepetitions:
        'one fresh native process per repetition, as many as the browser repetitions',
      setOrder: {
        seed: ORDER_SEED,
        algorithm: 'fisher-yates-descending',
        perRepetition: 'seed + r',
      },
      preparation:
        'one untimed buildFillMeshes call on the 1,000 requests per set; it provisions the arenas',
      init: {
        warmup: sample.initWarmup,
        timed: sample.initTimed,
        window:
          'from before one buildFillMeshes call on the set to after the fold of its last result',
      },
      edit: {
        warmupPaths: EDIT_WARMUP_PATHS,
        paths: sample.editPaths,
        seed: EDIT_SEED,
        algorithm: 'fisher-yates-descending over paths 0 .. paths - 1, seed + r',
        window:
          'from before one buildFillMeshes call on one request to after the fold of its result',
      },
      cold: 'one call per set on a second adapter over a fresh instance created and disposed outside timing; the window includes its reserve and arena growth',
      renderer: {
        stage: 'OB5-SR, report-only',
        call: 'PathMeshPipeline.prepare on the 1,000 path nodes with a cold cache, a fresh pipeline per set, on the provisioned adapter',
        limits: 'PATH_MESH_LIMITS unchanged',
        fringeBuilder: 'buildPathFringe, wrapped only to count its calls and time',
        camera: { position: { x: -640, y: -360 }, zoom: 1 },
        target: { width: 1280, height: 720, devicePixelRatio: 1 },
      },
      fold: 'FNV-1a 64 over the decoded results: per path in request order the status as u32 LE; on ok also V, T and the boundary pair count as u32 LE, then the position f64 bits LE, the indices u32 LE and the boundary pairs u32 LE (AL-S2 fold_decoded)',
      integrity:
        'each warm-up, timed and edit call (and the OB5-SR port call) advances the fill memory epoch by exactly 1 and leaves both arena capacities and the linear memory size unchanged; natively zero allocations and unchanged storage',
      visibility: 'the page stays visible for the whole repetition',
      retained: 'every raw sample, warm-up and preparation call with its window boundaries',
    },
    clock: {
      probe: 'the minimum positive performance.now increment q, observed before sampling (P2.5)',
      initQuantumMultiple: b0.decision.quantumMultiple,
      editQuantumMaxMs: b0.decision.budgets.editMs / 100,
    },
    native: {
      harness: 'p3_al_ob5_bench::run_ob5_native',
      role: 'report-only timing; its folds are the browser oracle (OB5-V1) and its build_path records the rung mix (OB5-V6)',
      ratio:
        'browser over native per set: per repetition the OB5-SP-init median ratio and the OB5-SP-edit p95 ratio, nearest-rank median over repetitions, per browser',
      ratioLabel: 'browser port time over native export time in the test-harness build',
    },
    oracle: {
      harness: 'p3_al_ob5_bench::run_ob5_oracle',
      dump: `${DUMP_SCHEMA} on the production caps (fill_ladder_dump_tests::dump_production)`,
      pathsPerSet: profile === 'reference' ? OB5_PATHS : ORACLE_FUNCTIONAL_PATHS,
      gates: ORACLE_GATES,
      meshCheck: 'the MESH_CHECK count over the oracle run and every native call is 0',
      reported: ['SL-O5', 'SL-O6'],
      notApplicable: {
        'SL-O4': 'the 2026-10-17 record has no s = 32 cell',
        'AL-I3': 'the frozen spike returns PREFIX above 68 points',
      },
      exportFold: 'the fold of every dumped export output equals the native per-path fold',
    },
    expectation: {
      source: 'OB5-U1, the committed status, rung and count summary (plan "Alt-A1 AL-OB5 OB5-U1")',
      sets: cells.map((cell) => ({
        set: cell.id,
        lambda: cell.lambda,
        paths: cell.paths,
        status: 'ok',
        rung: 'fast',
        flatCommands: flatCommands(cell.lambda),
        ...ob5ExpectedCounts(cell.lambda),
      })),
    },
    statistics: {
      percentile: 'nearest rank: ascending samples, index ceil(p * n) - 1',
      T: 'maximum over browsers, repetitions and sets of the OB5-SP-init median of the timed samples',
      Tp95: 'maximum of the OB5-SP-init p95, reported beside T',
      tEdit: 'maximum over browsers, repetitions and sets of the OB5-SP-edit p95',
      M: 'maximum over sets of the summed 16 V + 12 T bytes of the 1,000 results',
      payload: 'M plus 8 bytes per boundary pair, reported only',
    },
    decision: {
      rule: 'Alt-A1 product verdict (contract section 5.3), with the measured T, t_edit and M',
      budgets: b0.decision.budgets,
      identityItems: IDENTITY_ITEMS,
    },
    context: AL_U7_CONTEXT,
    memory: {
      observation: 'linearMemoryBytes() after the run, per browser',
      ceilingBytes: MEMORY_CEILING_BYTES,
      decisionInput: false,
    },
    validity: VALIDITY_IDS,
  };
}

export type Ob5Config = ReturnType<typeof scenarioConfig>;

/** The page options of a repetition, derived from the configuration. */
export function pageOptions(
  config: Ob5Config,
  wasmSha256: string,
): Omit<Ob5PageOptions, 'repetition'> {
  return {
    profile: config.profile,
    expectedWasmSha256: wasmSha256,
    expectedCorpusSha256: config.corpus.sha256,
    initWarmup: config.sampling.init.warmup,
    initTimed: config.sampling.init.timed,
    editPaths: config.sampling.edit.paths,
    renderer: {
      camera: config.sampling.renderer.camera,
      target: config.sampling.renderer.target,
    },
  };
}

/** FNV-1a 64 of bytes, as the native `fnv(FNV_OFFSET, bytes)`, in lowercase hex. */
export function fnvHex(bytes: Uint8Array): string {
  const fold = new Fnv1a64();
  fold.bytes(bytes);
  return fold.hex();
}

// ------------------------------------------------------------------------------------------
// Record types.

export interface NativeSamples {
  readonly ns: readonly number[];
  readonly checksums: readonly string[];
  readonly batchStatuses: readonly number[];
  readonly allocations: readonly number[];
}

export interface NativeSetOutput {
  readonly set: string;
  readonly paths: number;
  readonly inputBytes: number;
  readonly preparation: {
    readonly ns: number;
    readonly batchStatus: number;
    readonly checksum: string | null;
  };
  readonly statuses: readonly number[];
  readonly vertices: readonly number[];
  readonly triangles: readonly number[];
  readonly boundaryPairs: readonly number[];
  readonly pathChecksums: readonly string[];
  readonly warmup: NativeSamples;
  readonly timed: NativeSamples;
  readonly editWarmup: { readonly paths: readonly number[]; readonly checksums: readonly string[] };
  readonly editOrder: readonly number[];
  readonly edits: NativeSamples;
  readonly editChain: string;
  readonly storageStable: boolean;
  readonly rungs: readonly string[];
  readonly reasons: readonly (string | null)[];
  readonly steps: readonly (string | null)[];
  readonly meshes: readonly number[];
  readonly flatCommands: readonly number[];
}

export interface NativeOutput {
  readonly kind: 'ob5-native';
  readonly repetition: number;
  readonly revision: number;
  readonly clockQuantumNs: number;
  readonly corpus: { readonly bytes: number; readonly fnv: string };
  readonly setOrder: readonly string[];
  readonly sets: readonly NativeSetOutput[];
}

export interface ObservationOutput {
  readonly kind: 'ob5-observation';
  readonly revision: number;
  readonly corpus: { readonly bytes: number; readonly fnv: string };
  readonly sets: readonly {
    readonly set: string;
    readonly paths: number;
    readonly batchStatus: number;
    readonly statuses: readonly number[];
    readonly rungs: readonly string[];
    readonly reasons: readonly (string | null)[];
  }[];
}

export interface BrowserRecord {
  readonly schema: 'p3-al-ob5-browser/v1';
  readonly project: string;
  readonly channel: string | null;
  readonly browserVersion: string;
  readonly launchFlags: readonly string[];
  readonly repetition: number;
  readonly startedAt: string;
  readonly recordedAt: string;
  readonly instrumentation: Readonly<Record<string, boolean>>;
  readonly capture: Ob5Capture | null;
  readonly error: string | null;
}

export interface SliverAggregate {
  readonly set: string;
  readonly rung: 'fast' | 'exact';
  readonly meshes: number;
  readonly triangles: number;
  readonly nonFinite: number;
  readonly quality: { readonly min: number; readonly p5: number; readonly median: number } | null;
  readonly angle: { readonly min: number; readonly p5: number; readonly median: number } | null;
  readonly below01: number;
  readonly below001: number;
}

/** The evaluated oracle run (OB5-V7, OB5-V8), stored in the record. */
export interface Ob5OracleResults {
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
  /** The fold of each entry's dumped export output, by entry name. */
  readonly exportChecksums: Readonly<Record<string, string>>;
  readonly perSet: readonly {
    readonly set: string;
    readonly entries: number;
    readonly fast: number;
    readonly fallbacks: Readonly<Record<string, number>>;
    readonly exactOk: number;
  }[];
  /** SL-O5, reported. */
  readonly slivers: readonly SliverAggregate[];
  /** SL-O6, reported. */
  readonly geometricError: readonly {
    readonly set: string;
    readonly fastPaths: number;
    readonly maxCertifiedOverDelta: number | null;
    readonly maxExactOverDelta: number | null;
  }[];
  /** AL-I3 does not apply (section 5); its spike outcomes are counted, not judged. */
  readonly alI3: { readonly prefix: number; readonly other: number };
}

export interface Ob5Record {
  readonly schemaVersion: 1;
  readonly scenario: {
    readonly id: string;
    readonly version: number;
    readonly profile: Profile;
    readonly config: Ob5Config;
    readonly configHash: string;
  };
  readonly run: Readonly<Record<string, unknown>>;
  readonly environment: Readonly<Record<string, unknown>>;
  readonly builds: {
    readonly wasm: {
      readonly sha256: string;
      readonly bytes: number;
      readonly kernelSourceSha256: string | null;
    } & Readonly<Record<string, unknown>>;
    readonly native: {
      readonly kernelSourceSha256: string | null;
    } & Readonly<Record<string, unknown>>;
    readonly page: {
      readonly files: readonly { readonly path: string; readonly sha256: string }[];
    } & Readonly<Record<string, unknown>>;
  } & Readonly<Record<string, unknown>>;
  readonly corpus: { readonly sha256: string; readonly bytes: number; readonly fnv: string };
  readonly observationCorpus: {
    readonly sha256: string;
    readonly bytes: number;
    readonly fnv: string;
  };
  readonly native: {
    readonly repetitions: readonly NativeOutput[];
    readonly failures: readonly { readonly stage: string; readonly error: string }[];
  } | null;
  readonly observation: ObservationOutput | null;
  readonly oracle: Ob5OracleResults | null;
  readonly browsers: readonly BrowserRecord[];
  readonly failures: readonly { readonly stage: string; readonly error: string }[];
  readonly analysis?: unknown;
}

// ------------------------------------------------------------------------------------------
// The oracle run (OB5-V7).

/** The dump inputs of the oracle run: paths 0 .. pathsPerSet - 1 of each set, in set order. */
export function oracleInputs(profile: Profile): DumpInput[] {
  const perSet = scenarioConfig(profile).oracle.pathsPerSet;
  return ob5DecisionCells().flatMap((cell) =>
    generateCellPaths(cell, perSet).map((path, index): DumpInput => ({
      name: `ob5/${cell.id}#${index}`,
      kind: 'path',
      rule: 0,
      exponent: -3,
      verbs: path.verbs,
      points: path.points,
    })),
  );
}

/** The entry names the oracle run must hold, each exactly once. */
export function oracleNames(profile: Profile): string[] {
  const perSet = scenarioConfig(profile).oracle.pathsPerSet;
  return ob5DecisionCells().flatMap((cell) =>
    Array.from({ length: perSet }, (_, index) => `ob5/${cell.id}#${index}`),
  );
}

function setOf(name: string): string {
  return name.slice(name.indexOf('/') + 1, name.lastIndexOf('#'));
}

function hexBytes(bits: string): Uint8Array {
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setBigUint64(0, BigInt(`0x${bits}`), true);
  return bytes;
}

/** value / unit as a float, for reports only; exact BigInt scaling, as AL-S1's analysis does. */
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

/** The decoded fold of a dumped one-path export output, as the native `fold_path`. */
export function exportFold(entry: LadderEntry): string | null {
  const exported = entry.export;
  if (exported === null || exported.batchStatus !== 0 || exported.pathStatus === null) return null;
  const fold = new Fnv1a64();
  fold.u32(exported.pathStatus);
  if (exported.pathStatus !== 0) return fold.hex();
  if (exported.positions === null || exported.triangles === null || exported.boundaryEdges === null)
    return null;
  fold.u32(exported.positions.length);
  fold.u32(exported.triangles.length);
  fold.u32(exported.boundaryEdges.length);
  for (const [x, y] of exported.positions) {
    fold.bytes(hexBytes(x));
    fold.bytes(hexBytes(y));
  }
  for (const triangle of exported.triangles) for (const index of triangle) fold.u32(index);
  for (const pair of exported.boundaryEdges) for (const index of pair) fold.u32(index);
  return fold.hex();
}

function sliverAggregate(
  set: string,
  rung: 'fast' | 'exact',
  meshes: readonly SpikeMesh[],
): SliverAggregate {
  const all = meshes.flatMap((mesh) => sliverStatistics(mesh).perTriangle);
  const values = all.filter(
    (value) => Number.isFinite(value.quality) && Number.isFinite(value.angle),
  );
  const base = {
    set,
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

/**
 * Applies OB5-V7's gates to the production-cap dump and the harness output: SL-O1, SL-O2 and
 * SL-O3 with AL-U2's `evaluateEntry` on every entry, AL-I2 on every fallback path (module level
 * from the dump, export level from the harness), and the harness checks (zero allocations in a
 * ladder call, `build_path`'s rung equal to the module ladder's, kernel revision 2, the dump
 * complete); the `MESH_CHECK` count (OB5-V8); the export folds; then SL-O5 and SL-O6 as reports.
 * Pure: the runner passes the parsed dump, the harness output, the dump's hash and size and the
 * expected names.
 */
export function evaluateOb5Oracle(
  dump: LadderDump,
  harness: LadderOracleHarness,
  dumpIdentity: { sha256: string; bytes: number },
  expectedNames: readonly string[],
): Ob5OracleResults {
  const gates: Record<OracleGate, { checked: number; failures: string[] }> = {
    'SL-O1': { checked: 0, failures: [] },
    'SL-O2': { checked: 0, failures: [] },
    'SL-O3': { checked: 0, failures: [] },
    'AL-I2': { checked: 0, failures: [] },
    harness: { checked: 0, failures: [] },
  };
  const fail = (gate: OracleGate, detail: string) => gates[gate].failures.push(detail);
  if (dump.revision !== OPERATION_REVISION || harness.revision !== OPERATION_REVISION)
    fail(
      'harness',
      `kernel revision ${dump.revision}/${harness.revision}, not ${OPERATION_REVISION}`,
    );
  const records = new Map(harness.paths.map((path) => [path.name, path]));
  const meshCheck: string[] = [];
  const exportChecksums: Record<string, string> = {};
  const alI3 = { prefix: 0, other: 0 };
  interface Group {
    entries: number;
    fast: number;
    fallbacks: Record<string, number>;
    exactOk: number;
    fastMeshes: SpikeMesh[];
    exactMeshes: SpikeMesh[];
    maxCertified: number | null;
    maxExact: number | null;
  }
  const groups = new Map<string, Group>();
  for (const entry of dump.entries) {
    const evaluation = evaluateEntry(entry, dump.revision);
    for (const gate of ['SL-O1', 'SL-O2', 'SL-O3'] as const) {
      if (evaluation.checked[gate]) gates[gate].checked += 1;
      for (const failure of evaluation.failures[gate]) fail(gate, `${entry.name}: ${failure}`);
    }
    gates.harness.checked += 1;
    for (const failure of evaluation.failures.harness) fail('harness', `${entry.name}: ${failure}`);
    if (entry.reason === 'MESH_CHECK') meshCheck.push(entry.name);
    if (entry.kind === 'path' && entry.rung === 'fallback') {
      gates['AL-I2'].checked += 1;
      if (entry.ladderExactAgrees !== true)
        fail('AL-I2', `${entry.name}: the ladder's exact result differs from the exact rung`);
    }
    if (entry.spike.reason === 'PREFIX') alI3.prefix += 1;
    else alI3.other += 1;
    const built = records.get(entry.name);
    if (built === undefined) fail('harness', `${entry.name}: no build_path record`);
    else if (
      (built.rung === 'fast') !== (entry.rung === 'fast') ||
      (entry.rung === 'fallback' && built.reason !== entry.reason)
    )
      fail(
        'harness',
        `${entry.name}: build_path ${built.rung} ${built.reason ?? ''} against the ladder ${entry.rung} ${entry.reason ?? ''}`,
      );
    const folded = exportFold(entry);
    if (folded === null) fail('harness', `${entry.name}: no export output to fold`);
    else exportChecksums[entry.name] = folded;

    const name = setOf(entry.name);
    const group: Group = groups.get(name) ?? {
      entries: 0,
      fast: 0,
      fallbacks: {},
      exactOk: 0,
      fastMeshes: [],
      exactMeshes: [],
      maxCertified: null,
      maxExact: null,
    };
    groups.set(name, group);
    group.entries += 1;
    if (entry.rung === 'fast') group.fast += 1;
    else if (entry.reason) group.fallbacks[entry.reason] = (group.fallbacks[entry.reason] ?? 0) + 1;
    if (entry.exact?.status === 'OK') group.exactOk += 1;
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
        const unit = powerOfTwo(2 * entry.exponent);
        const exact = Math.sqrt(quotient(certificate.maxDeviationSquared, unit));
        if (Number.isFinite(exact))
          group.maxExact = group.maxExact === null ? exact : Math.max(group.maxExact, exact);
      }
    }
  }
  gates['AL-I2'].checked += harness.alI2.checked;
  for (const name of harness.alI2.failures) fail('AL-I2', `${name}: export output differs`);
  if (harness.paths.length !== dump.entries.length)
    fail('harness', 'harness and dump path counts differ');
  const seen = new Map<string, number>();
  for (const entry of dump.entries) seen.set(entry.name, (seen.get(entry.name) ?? 0) + 1);
  for (const name of expectedNames)
    if ((seen.get(name) ?? 0) !== 1)
      fail('harness', `dump has ${name} ${seen.get(name) ?? 0} times`);
  if (dump.entries.length !== expectedNames.length || harness.entries !== expectedNames.length)
    fail(
      'harness',
      `dump has ${dump.entries.length} entries (harness ${harness.entries}) for ${expectedNames.length} expected`,
    );
  const perSet: Ob5OracleResults['perSet'][number][] = [];
  const slivers: SliverAggregate[] = [];
  const geometricError: Ob5OracleResults['geometricError'][number][] = [];
  for (const [set, group] of groups) {
    perSet.push({
      set,
      entries: group.entries,
      fast: group.fast,
      fallbacks: group.fallbacks,
      exactOk: group.exactOk,
    });
    slivers.push(sliverAggregate(set, 'fast', group.fastMeshes));
    slivers.push(sliverAggregate(set, 'exact', group.exactMeshes));
    geometricError.push({
      set,
      fastPaths: group.fast,
      maxCertifiedOverDelta: group.maxCertified,
      maxExactOverDelta: group.maxExact,
    });
  }
  return {
    dump: { ...dumpIdentity, entries: dump.entries.length, revision: dump.revision },
    gates,
    meshCheck: { count: meshCheck.length, entries: meshCheck },
    exportChecksums,
    perSet,
    slivers,
    geometricError,
    alI3,
  };
}

/** Gate status from the stored failure lists. SL-O1, SL-O2 and the harness need a check. */
export function oracleStatus(oracle: Ob5OracleResults | null) {
  const gates = ORACLE_GATES.map((id) => {
    const gate = oracle?.gates[id];
    const checked = gate?.checked ?? 0;
    const failures = gate?.failures.length ?? 0;
    const needsCheck = id === 'SL-O1' || id === 'SL-O2' || id === 'harness';
    return {
      id,
      checked,
      failures,
      pass: gate !== undefined && failures === 0 && (!needsCheck || checked > 0),
    };
  });
  return {
    present: oracle !== null,
    valid: oracle !== null && gates.every((gate) => gate.pass),
    gates,
  };
}

// ------------------------------------------------------------------------------------------
// Analysis.

type Source = BrowserProject | 'native';

/** One set of one repetition of one leg, normalized to milliseconds and status names. */
interface SetLeg {
  readonly source: Source;
  readonly repetition: number;
  readonly set: string;
  readonly lambda: number;
  /** Folds of every call that must be identical: preparation, warm-up, timed and cold. */
  readonly callChecksums: readonly string[];
  readonly initMs: readonly number[];
  readonly editMs: readonly number[];
  readonly editChecksums: readonly string[];
  readonly editOrder: readonly number[];
  readonly editChain: string;
  readonly editWarmupChecksums: readonly string[];
  readonly statuses: readonly string[];
  readonly editStatuses: readonly string[];
  readonly vertices: readonly number[];
  readonly triangles: readonly number[];
  readonly boundaryPairs: readonly number[];
  readonly pathChecksums: readonly string[];
  readonly batchFailures: number;
  readonly integrity: readonly string[];
  readonly warmupCount: number;
  readonly timedCount: number;
}

const msOf = (sample: Ob5Sample) => sample.endMs - sample.startMs;
const statusName = (code: number) => STATUS_NAMES[code] ?? `status-${code}`;

function browserLegs(
  project: BrowserProject,
  repetition: number,
  capture: Ob5Capture,
  lambdas: ReadonlyMap<string, number>,
): SetLeg[] {
  return capture.sets.map((entry) => {
    const integrity: string[] = [];
    for (const [kind, samples] of [
      ['warm-up', entry.warmup],
      ['timed', entry.timed],
    ] as const)
      samples.forEach((item, index) => {
        if (item.epochDelta !== 1 || !item.storageStable)
          integrity.push(
            `${kind} ${index}: epoch +${item.epochDelta}, storage ${item.storageStable ? 'stable' : 'changed'}`,
          );
      });
    const edits = entry.edits;
    const badEdits = edits.epochDeltas.filter(
      (delta, index) => delta !== 1 || edits.storageStable[index] !== true,
    ).length;
    if (badEdits > 0) integrity.push(`${badEdits} edits with a reserve, growth or retry`);
    if (
      entry.renderer !== null &&
      (entry.renderer.epochDelta !== 1 || !entry.renderer.storageStable)
    )
      integrity.push(
        `OB5-SR port call: epoch +${entry.renderer.epochDelta}, storage ${entry.renderer.storageStable ? 'stable' : 'changed'}`,
      );
    const calls = [entry.preparation, ...entry.warmup, ...entry.timed, entry.cold];
    return {
      source: project,
      repetition,
      set: entry.set,
      lambda: lambdas.get(entry.set) ?? 0,
      callChecksums: calls.map((item) => item.checksum),
      initMs: entry.timed.map(msOf),
      editMs: edits.startMs.map((start, index) => (edits.endMs[index] ?? start) - start),
      editChecksums: edits.checksums,
      editOrder: edits.order,
      editChain: edits.chain,
      editWarmupChecksums: entry.editWarmup.checksums,
      statuses: entry.statuses,
      editStatuses: edits.statuses,
      vertices: entry.vertices,
      triangles: entry.triangles,
      boundaryPairs: entry.boundaryPairs,
      pathChecksums: entry.pathChecksums,
      batchFailures: calls.reduce((sum, item) => sum + item.batchFailures, 0),
      integrity,
      warmupCount: entry.warmup.length,
      timedCount: entry.timed.length,
    };
  });
}

function nativeLegs(output: NativeOutput, lambdas: ReadonlyMap<string, number>): SetLeg[] {
  return output.sets.map((entry) => {
    const integrity: string[] = [];
    const allocations = [
      ...entry.warmup.allocations,
      ...entry.timed.allocations,
      ...entry.edits.allocations,
    ].reduce((sum, value) => sum + value, 0);
    if (allocations !== 0) integrity.push(`${allocations} allocations in timed or warm-up calls`);
    if (!entry.storageStable) integrity.push('engine storage moved');
    const batchFailures = [
      entry.preparation.batchStatus,
      ...entry.warmup.batchStatuses,
      ...entry.timed.batchStatuses,
    ].filter((status) => status !== 0).length;
    return {
      source: 'native',
      repetition: output.repetition,
      set: entry.set,
      lambda: lambdas.get(entry.set) ?? 0,
      callChecksums: [
        entry.preparation.checksum ?? 'missing',
        ...entry.warmup.checksums,
        ...entry.timed.checksums,
      ],
      initMs: entry.timed.ns.map((ns) => ns / 1e6),
      editMs: entry.edits.ns.map((ns) => ns / 1e6),
      editChecksums: entry.edits.checksums,
      editOrder: entry.editOrder,
      editChain: entry.editChain,
      editWarmupChecksums: entry.editWarmup.checksums,
      statuses: entry.statuses.map(statusName),
      editStatuses: entry.edits.batchStatuses.map((status) =>
        status === 0 ? 'ok' : `batch-status-${status}`,
      ),
      vertices: entry.vertices,
      triangles: entry.triangles,
      boundaryPairs: entry.boundaryPairs,
      pathChecksums: entry.pathChecksums,
      batchFailures,
      integrity,
      warmupCount: entry.warmup.ns.length,
      timedCount: entry.timed.ns.length,
    };
  });
}

function percentiles(values: readonly number[]) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return {
    n: sorted.length,
    median: nearestRank(sorted, 0.5),
    p95: nearestRank(sorted, 0.95),
    p99: nearestRank(sorted, 0.99),
    min: sorted[0]!,
    max: sorted[sorted.length - 1]!,
  };
}

const median = (values: readonly number[]) =>
  values.length === 0
    ? null
    : nearestRank(
        [...values].sort((left, right) => left - right),
        0.5,
      );

function maximum(values: readonly (number | null)[]): number | null {
  if (values.length === 0 || values.some((value) => value === null)) return null;
  return Math.max(...(values as number[]));
}

function meshBytes(leg: SetLeg): number {
  let bytes = 0;
  for (let index = 0; index < leg.vertices.length; index += 1)
    bytes += 16 * leg.vertices[index]! + 12 * leg.triangles[index]!;
  return bytes;
}

function payloadBytes(leg: SetLeg): number {
  return meshBytes(leg) + 8 * leg.boundaryPairs.reduce((sum, value) => sum + value, 0);
}

export type Verdict = 'NONE' | 'INVALID' | 'FEASIBLE' | 'INFEASIBLE' | 'INCONCLUSIVE';

export function analyze(record: Ob5Record) {
  const config = record.scenario.config;
  const reference = record.scenario.profile === 'reference';
  const repetitions = config.sampling.repetitions;
  const setIds = config.corpus.cells.map((cell) => cell.id);
  const lambdas = new Map(config.corpus.cells.map((cell) => [cell.id, cell.lambda]));
  const expectations = new Map(config.expectation.sets.map((item) => [item.set, item]));
  const editPaths = config.sampling.edit.paths;

  // Completeness issues (OB5-V12) and the per-leg views.
  const missing: string[] = [];
  const captures: { project: BrowserProject; repetition: number; capture: Ob5Capture }[] = [];
  for (const project of BROWSER_PROJECTS) {
    const records = record.browsers.filter((item) => item.project === project);
    if (records.length !== repetitions)
      missing.push(`${project}: ${records.length} of ${repetitions} repetitions`);
    for (let repetition = 0; repetition < repetitions; repetition += 1) {
      const item = records.filter((candidate) => candidate.repetition === repetition);
      if (item.length !== 1) {
        missing.push(`${project} r${repetition}: ${item.length} records`);
        continue;
      }
      const { capture, error } = item[0]!;
      if (error !== null || capture === null) {
        missing.push(`${project} r${repetition} failed: ${error ?? 'no capture'}`);
        continue;
      }
      if (capture.errors.length > 0) missing.push(`${project} r${repetition} errors`);
      captures.push({ project, repetition, capture });
    }
  }
  const nativeOutputs = record.native?.repetitions ?? [];
  if (record.native === null) missing.push('native leg missing');
  else {
    for (const failure of record.native.failures) missing.push(`native ${failure.stage}`);
    for (let repetition = 0; repetition < repetitions; repetition += 1)
      if (nativeOutputs.filter((item) => item.repetition === repetition).length !== 1)
        missing.push(`native r${repetition}: not exactly one output`);
    if (nativeOutputs.length !== repetitions)
      missing.push(`native: ${nativeOutputs.length} of ${repetitions} repetitions`);
  }
  if (record.oracle === null) missing.push('oracle run missing');
  for (const failure of record.failures) missing.push(`stage ${failure.stage}`);

  const legs: SetLeg[] = [
    ...captures.flatMap(({ project, repetition, capture }) =>
      browserLegs(project, repetition, capture, lambdas),
    ),
    ...nativeOutputs.flatMap((output) => nativeLegs(output, lambdas)),
  ];
  interface SourceSets {
    readonly source: Source;
    readonly repetition: number;
    readonly sets: readonly string[];
  }
  const sources: SourceSets[] = [
    ...captures.map(({ project, repetition, capture }): SourceSets => ({
      source: project,
      repetition,
      sets: capture.sets.map((item) => item.set),
    })),
    ...nativeOutputs.map((output): SourceSets => ({
      source: 'native',
      repetition: output.repetition,
      sets: output.sets.map((item) => item.set),
    })),
  ];
  for (const { source, repetition, sets } of sources)
    for (const id of setIds)
      if (sets.filter((set) => set === id).length !== 1)
        missing.push(`${source} r${repetition} ${id}: not exactly one set`);
  for (const leg of legs) {
    const name = `${leg.source} r${leg.repetition} ${leg.set}`;
    if (
      leg.warmupCount !== config.sampling.init.warmup ||
      leg.timedCount !== config.sampling.init.timed
    )
      missing.push(`${name}: init sample counts`);
    if (leg.editMs.length !== editPaths || leg.editChecksums.length !== editPaths)
      missing.push(`${name}: ${leg.editMs.length} of ${editPaths} edits`);
    if (leg.pathChecksums.length !== OB5_PATHS) missing.push(`${name}: per-path folds`);
  }
  for (const { project, repetition, capture } of captures)
    for (const entry of capture.sets)
      if (entry.renderer === null)
        missing.push(`${project} r${repetition} ${entry.set}: no OB5-SR sample`);

  const checks: { id: ValidityId; pass: boolean; detail: string }[] = [];
  const check = (id: ValidityId, issues: readonly string[], ok: string) =>
    checks.push({ id, pass: issues.length === 0, detail: issues.slice(0, 20).join('; ') || ok });
  const legName = (leg: SetLeg) => `${leg.source} r${leg.repetition} ${leg.set}`;
  const browserSetLegs = legs.filter((leg) => leg.source !== 'native');
  const nativeSetLegs = legs.filter((leg) => leg.source === 'native');

  // OB5-V1: browser equals native (only two present checksums that differ fail).
  const v1: string[] = [];
  for (const leg of browserSetLegs) {
    const natives = nativeSetLegs.filter((item) => item.set === leg.set);
    const nativeInit = new Set(natives.flatMap((item) => item.callChecksums));
    const nativePaths = natives[0]?.pathChecksums;
    for (const checksum of new Set(leg.callChecksums))
      for (const nativeChecksum of nativeInit)
        if (checksum !== nativeChecksum)
          v1.push(`${legName(leg)} init fold ${checksum} != native ${nativeChecksum}`);
    const nativeEdit = natives.find((item) => item.repetition === leg.repetition);
    if (nativeEdit !== undefined && nativeEdit.editChain !== leg.editChain)
      v1.push(`${legName(leg)} edit fold ${leg.editChain} != native ${nativeEdit.editChain}`);
    if (nativePaths !== undefined) {
      const differing = leg.pathChecksums.filter(
        (checksum, index) => nativePaths[index] !== undefined && checksum !== nativePaths[index],
      ).length;
      if (differing > 0) v1.push(`${legName(leg)}: ${differing} per-path folds differ from native`);
    }
  }
  check(
    'OB5-V1',
    v1,
    'every present browser fold equals the native fold of the same set and order',
  );

  // OB5-V2: deterministic output.
  const v2: string[] = [];
  for (const leg of legs) {
    if (new Set(leg.callChecksums).size > 1)
      v2.push(`${legName(leg)}: the set's calls fold differently`);
    const editDiffers = leg.editChecksums.filter(
      (checksum, index) => checksum !== leg.pathChecksums[leg.editOrder[index] ?? -1],
    ).length;
    if (editDiffers > 0)
      v2.push(`${legName(leg)}: ${editDiffers} edits differ from the batch result`);
    leg.editWarmupChecksums.forEach((checksum, index) => {
      if (checksum !== leg.pathChecksums[EDIT_WARMUP_PATHS[index] ?? -1])
        v2.push(`${legName(leg)}: untimed edit ${index} differs from the batch result`);
    });
  }
  for (const id of setIds) {
    const distinct = new Set(
      nativeSetLegs.filter((leg) => leg.set === id).map((leg) => canonicalJson(leg.pathChecksums)),
    );
    if (distinct.size > 1) v2.push(`native ${id}: per-path folds differ between repetitions`);
  }
  check('OB5-V2', v2, 'every call of a set has one fold; every edit equals its path in the batch');

  // OB5-V3: expected meshes, flat commands and M.
  const v3: string[] = [];
  for (const leg of legs) {
    const expected = expectations.get(leg.set);
    if (expected === undefined) {
      v3.push(`${legName(leg)}: unknown set`);
      continue;
    }
    let differing = 0;
    for (let index = 0; index < expected.paths; index += 1)
      if (
        leg.statuses[index] !== 'ok' ||
        leg.vertices[index] !== expected.vertices ||
        leg.triangles[index] !== expected.triangles ||
        leg.boundaryPairs[index] !== expected.boundaryPairs
      )
        differing += 1;
    if (differing > 0 || leg.vertices.length !== expected.paths)
      v3.push(
        `${legName(leg)}: ${differing} paths differ from V ${expected.vertices}, T ${expected.triangles}, B ${expected.boundaryPairs}`,
      );
    const want = expected.paths * (16 * expected.vertices + 12 * expected.triangles);
    if (meshBytes(leg) !== want) v3.push(`${legName(leg)}: M ${meshBytes(leg)} != ${want}`);
  }
  for (const output of nativeOutputs)
    for (const entry of output.sets) {
      const expected = expectations.get(entry.set);
      const wrong = entry.flatCommands.filter((count) => count !== expected?.flatCommands).length;
      if (wrong > 0 || entry.flatCommands.length !== (expected?.paths ?? -1))
        v3.push(
          `native r${output.repetition} ${entry.set}: ${wrong} flat command counts differ from ${expected?.flatCommands}`,
        );
    }
  check(
    'OB5-V3',
    v3,
    'every path has the expected flat commands, V, T and boundary pairs; M as expected',
  );

  // OB5-V4: operation identity, hashes and orders.
  const v4: string[] = [];
  const runKernel = kernelSourceSha256((record.run as { sourceManifest?: unknown }).sourceManifest);
  if (runKernel === null) v4.push('no kernel sources in the source manifest');
  if (
    record.builds.wasm.kernelSourceSha256 !== runKernel ||
    record.builds.native.kernelSourceSha256 !== runKernel
  )
    v4.push('the native and WASM builds do not name the run kernel sources');
  if (record.corpus.sha256 !== config.corpus.sha256) v4.push('corpus SHA-256');
  for (const { project, repetition, capture } of captures) {
    const name = `${project} r${repetition}`;
    const expected = { ...pageOptions(config, record.builds.wasm.sha256), repetition };
    if (canonicalJson(capture.options) !== canonicalJson(expected)) v4.push(`${name} page options`);
    if (capture.wasmSha256 !== record.builds.wasm.sha256) v4.push(`${name} WASM SHA-256`);
    if (capture.corpusSha256 !== config.corpus.sha256) v4.push(`${name} corpus SHA-256`);
    if (
      capture.adapter?.operationId !== config.operation.id ||
      capture.adapter.portVersion !== config.operation.portVersion
    )
      v4.push(`${name} adapter identity`);
    if (canonicalJson(capture.order) !== canonicalJson(setOrder(setIds, repetition)))
      v4.push(`${name} set order`);
  }
  for (const output of nativeOutputs) {
    const name = `native r${output.repetition}`;
    if (output.revision !== config.operation.revision)
      v4.push(`${name} revision ${output.revision}`);
    if (output.corpus.fnv !== record.corpus.fnv || output.corpus.bytes !== record.corpus.bytes)
      v4.push(`${name} corpus bytes`);
    if (canonicalJson(output.setOrder) !== canonicalJson(setOrder(setIds, output.repetition)))
      v4.push(`${name} set order`);
  }
  for (const leg of legs)
    if (canonicalJson(leg.editOrder) !== canonicalJson(editOrder(editPaths, leg.repetition)))
      v4.push(`${legName(leg)} edit order`);
  check(
    'OB5-V4',
    v4,
    'operation, revision, port version, hashes, kernel sources and orders as pinned',
  );

  // OB5-V5: workload admitted.
  const v5: string[] = [];
  for (const leg of legs) {
    const failing = leg.statuses.filter((status) => status !== 'ok').length;
    const editFailing = leg.editStatuses.filter((status) => status !== 'ok').length;
    if (failing > 0 || leg.statuses.length !== OB5_PATHS)
      v5.push(`${legName(leg)}: ${failing} paths not ok`);
    if (editFailing > 0) v5.push(`${legName(leg)}: ${editFailing} edits not ok`);
    if (leg.batchFailures > 0) v5.push(`${legName(leg)}: ${leg.batchFailures} batch failures`);
  }
  check('OB5-V5', v5, 'every path ok in every call; no batch failure');

  // OB5-V6: rung mix through build_path, as expected and identical across native repetitions.
  const v6: string[] = [];
  const mixes = new Map<string, Set<string>>();
  for (const output of nativeOutputs)
    for (const entry of output.sets) {
      const expected = expectations.get(entry.set);
      const unexpected = entry.rungs.filter(
        (rung, index) =>
          rung !== expected?.rung || entry.reasons[index] !== null || entry.steps[index] !== null,
      ).length;
      if (unexpected > 0 || entry.rungs.length !== (expected?.paths ?? -1))
        v6.push(
          `native r${output.repetition} ${entry.set}: ${unexpected} paths off the expected rung`,
        );
      const mix = canonicalJson({ rungs: entry.rungs, reasons: entry.reasons, steps: entry.steps });
      const known = mixes.get(entry.set) ?? new Set<string>();
      known.add(mix);
      mixes.set(entry.set, known);
    }
  for (const [set, known] of mixes)
    if (known.size > 1) v6.push(`${set}: the rung mix differs between native repetitions`);
  if (nativeOutputs.length === 0) v6.push('no native rung records');
  check(
    'OB5-V6',
    v6,
    'every path on the expected rung with no fallback reason; identical across repetitions',
  );

  // OB5-V7: certificate and mesh oracles, and the export folds against the native per-path folds.
  const gates = oracleStatus(record.oracle);
  const v7: string[] = gates.gates
    .filter((gate) => !gate.pass)
    .map((gate) => `${gate.id}: ${gate.failures} failures of ${gate.checked}`);
  if (record.oracle === null) v7.push('no oracle run');
  else {
    const names = oracleNames(record.scenario.profile);
    const firstNative = new Map(
      nativeSetLegs
        .filter((leg) => leg.repetition === 0)
        .map((leg) => [leg.set, leg.pathChecksums]),
    );
    let differing = 0;
    for (const name of names) {
      const index = Number(name.slice(name.lastIndexOf('#') + 1));
      const nativeChecksum = firstNative.get(setOf(name))?.[index];
      const exported = record.oracle.exportChecksums[name];
      if (exported === undefined || nativeChecksum === undefined || exported !== nativeChecksum)
        differing += 1;
    }
    if (differing > 0)
      v7.push(`${differing} oracle export folds differ from the native per-path folds`);
  }
  check(
    'OB5-V7',
    v7,
    'SL-O1, SL-O2, SL-O3, AL-I2 and the harness gates pass; the judged meshes are the timed ones',
  );

  // OB5-V8: MESH_CHECK count 0 over the oracle run and every native call.
  const nativeMeshChecks = nativeOutputs.reduce(
    (sum, output) =>
      sum +
      output.sets.reduce(
        (count, entry) => count + entry.reasons.filter((reason) => reason === 'MESH_CHECK').length,
        0,
      ),
    0,
  );
  const oracleMeshChecks = record.oracle?.meshCheck.count ?? null;
  check(
    'OB5-V8',
    [
      ...(oracleMeshChecks === null
        ? ['no oracle run']
        : oracleMeshChecks > 0
          ? [`oracle MESH_CHECK ${oracleMeshChecks}`]
          : []),
      ...(nativeMeshChecks > 0 ? [`native MESH_CHECK ${nativeMeshChecks}`] : []),
    ],
    'MESH_CHECK count 0',
  );

  // OB5-V9: no reserve, growth or retry while timing.
  check(
    'OB5-V9',
    legs.flatMap((leg) => leg.integrity.map((item) => `${legName(leg)} ${item}`)),
    'every timed, warm-up and edit call advanced the epoch by 1 with unchanged storage; natively no allocation',
  );

  // OB5-V10: clock resolution.
  const v10: string[] = [];
  for (const { project, repetition, capture } of captures) {
    const name = `${project} r${repetition}`;
    const quantum = capture.clockProbe.minimumQuantumMs;
    if (capture.crossOriginIsolated !== true) v10.push(`${name} not cross-origin isolated`);
    if (quantum === null) {
      v10.push(`${name} no clock quantum`);
      continue;
    }
    if (quantum > config.clock.editQuantumMaxMs)
      v10.push(`${name} q ${quantum} ms > ${config.clock.editQuantumMaxMs} ms`);
    for (const entry of capture.sets)
      if (entry.timed.some((item) => msOf(item) < config.clock.initQuantumMultiple * quantum))
        v10.push(`${name} ${entry.set} init sample UNVERIFIED`);
  }
  check(
    'OB5-V10',
    v10,
    'cross-origin isolated; init samples at least 100 quanta; q at most B_edit / 100',
  );

  // OB5-V11: visibility.
  const v11 = captures
    .filter(
      ({ capture }) =>
        capture.environment.visibilityStart !== 'visible' ||
        capture.environment.visibilityEnd !== 'visible' ||
        capture.environment.visibilityEvents.length > 0,
    )
    .map(({ project, repetition }) => `${project} r${repetition}`);
  check('OB5-V11', v11, 'every page visible for its whole repetition');

  // OB5-V12: repetitions complete.
  check('OB5-V12', missing, 'every browser and native repetition, set and sample present');

  // OB5-V13: a clean committed tree (required for the reference profile).
  const run = record.run as Record<string, unknown>;
  const manifest = (run.sourceManifest ?? {}) as Record<string, unknown>;
  const commitCheck = run.commitCheck as { checked?: unknown; mismatches?: unknown } | undefined;
  const v13: string[] = [];
  const commitIssues: string[] = [];
  if (run.dirty !== false) commitIssues.push('the worktree was dirty');
  if (
    commitCheck === undefined ||
    commitCheck.checked !== Object.keys(manifest).length ||
    !Array.isArray(commitCheck.mismatches) ||
    commitCheck.mismatches.length > 0
  )
    commitIssues.push('a source-manifest file differs from the commit');
  if (reference) v13.push(...commitIssues);
  check(
    'OB5-V13',
    v13,
    reference
      ? 'clean committed tree; every manifest file equals the commit'
      : `not required for the functional profile (${commitIssues.join('; ') || 'clean committed tree'})`,
  );

  // OB5-V14: metadata complete.
  const environment = record.environment as Record<string, unknown>;
  const native = record.builds.native as Record<string, unknown>;
  const browserFields = record.browsers.flatMap((item) => {
    const name = `${item.project} r${item.repetition}`;
    const viewport = item.capture?.environment.viewport;
    return [
      [`${name}.channel`, item.channel],
      [`${name}.browserVersion`, item.browserVersion],
      [`${name}.launchFlags`, item.launchFlags.length > 0 ? item.launchFlags : null],
      [`${name}.viewport`, viewport && viewport.width > 0 && viewport.height > 0 ? viewport : null],
      [
        `${name}.devicePixelRatio`,
        viewport && Number.isFinite(viewport.devicePixelRatio) ? viewport.devicePixelRatio : null,
      ],
      [`${name}.linearMemoryBytes`, item.capture?.linearMemoryBytes],
    ];
  });
  const knownOverhead = native.knownOverhead;
  const absent = [
    ['run.commit', run.commit],
    ['run.utcStart', run.utcStart],
    ['run.utcEnd', run.utcEnd],
    ['run.timezone', run.timezone],
    ['run.runner', run.runner],
    ['run.command', run.command],
    ['environment.os', environment.os],
    ['environment.cpu', environment.cpu],
    ['environment.logicalCores', environment.logicalCores],
    ['environment.memoryBytes', environment.memoryBytes],
    ['environment.processListing', environment.processListing],
    ['environment.gpu', environment.gpu],
    ...(reference
      ? [
          ['environment.observedAt', environment.observedAt],
          ['environment.power', environment.power],
          ['environment.backgroundLoad', environment.backgroundLoad],
          ['environment.quietMachine', environment.quietMachine],
        ]
      : []),
    ['builds.wasm.sha256', record.builds.wasm.sha256],
    ['builds.page', record.builds.page],
    ['builds.native.toolchain', native.toolchain],
    ['builds.native.target', native.target],
    ['builds.native.profile', native.profile],
    ['builds.native.rustflags', native.rustflags],
    [
      'builds.native.knownOverhead',
      Array.isArray(knownOverhead) && knownOverhead.length > 0 ? knownOverhead : null,
    ],
    ...browserFields,
  ]
    .filter(([, value]) => value === undefined || value === null || value === '')
    .map(([name]) => name as string);
  check('OB5-V14', absent, 'complete');

  // Statistics (section 3.4).
  const legStatistics = legs.map((leg) => ({
    source: leg.source,
    repetition: leg.repetition,
    set: leg.set,
    init: percentiles(leg.initMs),
    edit: percentiles(leg.editMs),
    meshBytes: meshBytes(leg),
    payloadBytes: payloadBytes(leg),
  }));
  const browserStatistics = legStatistics.filter((item) => item.source !== 'native');
  const complete =
    browserStatistics.length === BROWSER_PROJECTS.length * repetitions * setIds.length;
  const decide = (pick: (item: (typeof legStatistics)[number]) => number | null) =>
    complete ? maximum(browserStatistics.map(pick)) : null;
  const T = decide((item) => item.init?.median ?? null);
  const Tp95 = decide((item) => item.init?.p95 ?? null);
  const tEdit = decide((item) => item.edit?.p95 ?? null);
  const perSetMesh = setIds.map((set) => {
    const values = legStatistics.filter((item) => item.set === set);
    return {
      set,
      meshBytes: values.length === 0 ? null : Math.max(...values.map((item) => item.meshBytes)),
      payloadBytes:
        values.length === 0 ? null : Math.max(...values.map((item) => item.payloadBytes)),
    };
  });
  const M = maximum(perSetMesh.map((item) => item.meshBytes));
  const payload = maximum(perSetMesh.map((item) => item.payloadBytes));
  const budgets = config.decision.budgets;
  const ratios = {
    initial: T === null ? null : T / budgets.initialMs,
    edit: tEdit === null ? null : tEdit / budgets.editMs,
    mesh: M === null ? null : M / budgets.meshBytes,
  };
  const perSet = setIds.map((set) => {
    const values = browserStatistics.filter((item) => item.set === set);
    return {
      set,
      initMedianMax: maximum(values.map((item) => item.init?.median ?? null)),
      initP95Max: maximum(values.map((item) => item.init?.p95 ?? null)),
      editP95Max: maximum(values.map((item) => item.edit?.p95 ?? null)),
      meshBytes: perSetMesh.find((item) => item.set === set)?.meshBytes ?? null,
    };
  });

  // Report-only: native, the ratio browser over native, cold, the renderer and memory.
  const statisticOf = (source: Source, repetition: number, set: string) =>
    legStatistics.find(
      (item) => item.source === source && item.repetition === repetition && item.set === set,
    );
  const nativeRatio = BROWSER_PROJECTS.flatMap((project) =>
    setIds.map((set) => {
      const init: number[] = [];
      const edit: number[] = [];
      for (let repetition = 0; repetition < repetitions; repetition += 1) {
        const browser = statisticOf(project, repetition, set);
        const nativeItem = statisticOf('native', repetition, set);
        if (browser?.init && nativeItem?.init && nativeItem.init.median > 0)
          init.push(browser.init.median / nativeItem.init.median);
        if (browser?.edit && nativeItem?.edit && nativeItem.edit.p95 > 0)
          edit.push(browser.edit.p95 / nativeItem.edit.p95);
      }
      return { project, set, initMedianRatio: median(init), editP95Ratio: median(edit) };
    }),
  );
  const cold = captures.flatMap(({ project, repetition, capture }) =>
    capture.sets.map((entry) => ({ project, repetition, set: entry.set, ms: msOf(entry.cold) })),
  );
  const renderer = captures.flatMap(({ project, repetition, capture }) =>
    capture.sets.map((entry) => ({
      project,
      repetition,
      set: entry.set,
      ms: entry.renderer === null ? null : entry.renderer.endMs - entry.renderer.startMs,
      draws: entry.renderer?.draws ?? null,
      regionOnly: entry.renderer?.regionOnly ?? null,
      fringed: entry.renderer?.fringed ?? null,
      builderCalls: entry.renderer?.builderCalls ?? null,
      builderMs: entry.renderer?.builderMs ?? null,
      builderShare:
        entry.renderer === null || entry.renderer.endMs <= entry.renderer.startMs
          ? null
          : entry.renderer.builderMs / (entry.renderer.endMs - entry.renderer.startMs),
      fringeWorkCapNotices: entry.renderer?.notices['fringe-work-cap'] ?? 0,
      notices: entry.renderer?.notices ?? {},
    })),
  );
  const memory = BROWSER_PROJECTS.map((project) => {
    const values = captures
      .filter((item) => item.project === project)
      .map((item) => item.capture.linearMemoryBytes);
    const bytes = values.length === 0 ? null : maximum(values);
    return {
      project,
      linearMemoryBytes: bytes,
      withinCeiling: bytes === null ? null : bytes <= config.memory.ceilingBytes,
    };
  });
  const observation =
    record.observation === null
      ? null
      : record.observation.sets.map((entry) => {
          const tally: Record<string, number> = {};
          entry.rungs.forEach((rung, index) => {
            const key = `${statusName(entry.statuses[index] ?? -1)}/${rung}${entry.reasons[index] ? `/${entry.reasons[index]}` : ''}`;
            tally[key] = (tally[key] ?? 0) + 1;
          });
          return {
            set: entry.set,
            paths: entry.paths,
            batchStatus: entry.batchStatus,
            corpusMatches:
              record.observation!.corpus.fnv === record.observationCorpus.fnv &&
              record.observation!.corpus.bytes === record.observationCorpus.bytes,
            outcomes: tally,
          };
        });

  // The verdict (section 4).
  const failed = checks.filter((item) => !item.pass).map((item) => item.id);
  const invalidItems = failed.filter((id) => IDENTITY_ITEMS.includes(id));
  const valid = failed.length === 0;
  let verdict: Verdict;
  let reason: string;
  const over: string[] = [];
  if (invalidItems.length > 0) {
    verdict = 'INVALID';
    reason = `output identity fails: ${invalidItems.join(', ')}`;
  } else if (!reference) {
    verdict = 'NONE';
    reason = 'functional profile';
  } else if (!valid || T === null || tEdit === null || M === null) {
    verdict = 'INCONCLUSIVE';
    reason = `validity items fail: ${failed.join(', ') || 'statistics missing'}`;
  } else {
    if (T > budgets.initialMs) over.push(`T ${T.toFixed(1)} ms > ${budgets.initialMs} ms`);
    if (tEdit > budgets.editMs) over.push(`t_edit ${tEdit.toFixed(3)} ms > ${budgets.editMs} ms`);
    if (M > budgets.meshBytes) over.push(`M ${M} bytes > ${budgets.meshBytes} bytes`);
    verdict = over.length === 0 ? 'FEASIBLE' : 'INFEASIBLE';
    reason =
      over.length === 0
        ? 'every validity item passes and T, t_edit and M are within budget'
        : over.join('; ');
  }

  return {
    checks,
    valid,
    verdict,
    reason,
    T,
    Tp95,
    tEdit,
    meshBytes: M,
    payloadBytes: payload,
    ratios,
    perSet,
    legs: legStatistics,
    nativeRatio,
    nativeRatioLabel: config.native.ratioLabel,
    cold,
    renderer,
    memory,
    oracle: gates,
    observation,
    context: config.context,
  };
}

export type Ob5Analysis = ReturnType<typeof analyze>;

/**
 * Rejects a record whose schema, scenario identity, pinned configuration or its hash, corpus
 * bytes (regenerated), WASM or kernel-source hashes, or stored analysis (recomputed from the raw
 * samples: every statistic, item and the verdict) differs.
 */
export function validateOb5Record(record: Ob5Record): void {
  if (record.schemaVersion !== OB5_SCHEMA_VERSION) throw new Error('unsupported schema version');
  if (record.scenario.id !== OB5_SCENARIO_ID || record.scenario.version !== OB5_SCENARIO_VERSION)
    throw new Error('scenario identity mismatch');
  if (configHash(record.scenario.config) !== record.scenario.configHash)
    throw new Error('configuration hash mismatch');
  if (
    canonicalJson(record.scenario.config) !== canonicalJson(scenarioConfig(record.scenario.profile))
  )
    throw new Error('configuration differs from scenarioConfig');
  const corpus = encodeOb5DecisionCorpus();
  if (
    record.corpus.sha256 !== OB5_CORPUS_SHA256 ||
    sha256Hex(corpus) !== record.corpus.sha256 ||
    record.corpus.bytes !== corpus.length ||
    record.corpus.fnv !== fnvHex(corpus)
  )
    throw new Error('corpus hash mismatch');
  const observation = encodeOb5ObservationCorpus();
  if (
    record.observationCorpus.sha256 !== sha256Hex(observation) ||
    record.observationCorpus.bytes !== observation.length ||
    record.observationCorpus.fnv !== fnvHex(observation)
  )
    throw new Error('observation corpus hash mismatch');
  const asset = (name: string) =>
    record.builds.page.files.find((file) => file.path === name)?.sha256;
  if (
    !/^[0-9a-f]{64}$/u.test(record.builds.wasm.sha256) ||
    asset('geometry.wasm') !== record.builds.wasm.sha256
  )
    throw new Error('WASM hash mismatch');
  if (asset('corpus.bin') !== record.corpus.sha256) throw new Error('page corpus asset mismatch');
  const kernel = kernelSourceSha256((record.run as { sourceManifest?: unknown }).sourceManifest);
  if (
    record.builds.wasm.kernelSourceSha256 !== kernel ||
    record.builds.native.kernelSourceSha256 !== kernel
  )
    throw new Error('kernel-source hash mismatch');
  if (canonicalJson(analyze(record)) !== canonicalJson(record.analysis))
    throw new Error('stored analysis differs from the recomputation');
}
