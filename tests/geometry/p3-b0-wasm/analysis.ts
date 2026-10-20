/**
 * P3 Alt-A1 unit AL-U6 (`docs/plans/p3-alt-a1-fill-ladder-contract.md` sections 5.2 and 5.3):
 * scenario AL-S2, `p3-b0-wasm` v1 (B0-W). The pinned configuration and its hash, the analysis
 * of a record (browser and native per-path medians, the ratio table, k̂ and the report-only
 * k̂₁, the validity items), the product verdict from the linked AL-S1 record with k = k̂, and
 * the validator `validateWasmRecord`.
 *
 * The native leg is the AL-S1 harness's ratio mode, AL-U5's `runRatioMode`; its configuration
 * (`ratioModeConfig`), native analysis (`analyzeRatioNative`) and the product verdict under
 * B0's unchanged rule (`productVerdict`) are imported from AL-U5's analysis, unchanged, so the
 * two scenarios cannot drift apart.
 *
 * How the combined record links AL-S1: `alS1` holds the repository path of the committed AL-S1
 * reference record (`docs/benchmarks/results/*_p3_p3-fill-ladder-v1_*.json`), the SHA-256 of
 * its bytes, its run ID, profile and configuration hash, and a copy of the parts of its
 * analysis the verdict reads (estimates, checks, invalid reasons, its own verdict). The
 * validator takes the linked file's bytes, checks the hash, re-validates that record with
 * `validateLadderRecord`, rebuilds the link and compares it, then recomputes this record.
 *
 * Erasable TypeScript only, so the Node runner can load it directly.
 */
import { createHash } from 'node:crypto';
import { canonicalJson, configHash, leaves, nearestRank } from '../p3-b0/analysis.js';
import { corpusCells, scenarioConfig as b0ScenarioConfig, type Profile } from '../p3-b0/corpus.js';
import { CORPUS_SHA256 } from '../p3-b0-spike/analysis.js';
import {
  analyzeRatioNative,
  LADDER_SCENARIO_ID,
  LADDER_SCENARIO_VERSION,
  OPERATION_ID,
  OPERATION_REVISION,
  productVerdict,
  ratioModeConfig,
  validateLadderRecord,
  type LadderAnalysis,
  type LadderRecord,
  type RatioOutput,
} from '../p3-fill-ladder/analysis.js';
import type {
  WasmCapture,
  WasmCellCapture,
  WasmPageOptions,
} from '../../geometry-benchmark/p3-b0-wasm/workload.js';

export { CORPUS_SHA256, OPERATION_ID, OPERATION_REVISION };
export const WASM_SCENARIO_ID = 'p3-b0-wasm';
export const WASM_SCENARIO_VERSION = 1;
export const WASM_RUNNER_VERSION = 'p3-b0-wasm-runner/1';
export const WASM_SCHEMA_VERSION = 1;
/** Section 5.2: the label k̂ carries in the record. */
export const K_LABEL = 'browser port time over native export time in the test-harness build';
export const BROWSER_PROJECTS = ['chrome', 'edge'] as const;
export type BrowserProject = (typeof BROWSER_PROJECTS)[number];
export const VALIDITY_IDS = [
  'repetitions-complete',
  'checksums-equal-native',
  'largest-primary-verified',
  'no-reserve-or-growth',
  'largest-cells-admitted',
  'operation-identity',
  'native-leg-valid',
  'metadata-complete',
] as const;
export type ValidityId = (typeof VALIDITY_IDS)[number];
const DECISION_PATHS = 10;
const MEMORY_CEILING_BYTES = 256 * 2 ** 20;

/** The largest-L decision cell of each primary series, in series order (section 5.2). */
export function largestCells(): string[] {
  const decision = b0ScenarioConfig('reference').decision;
  const cells = corpusCells();
  return decision.primarySeries.map(
    (series) =>
      cells
        .filter((cell) => cell.role === 'decision' && cell.series === series)
        .reduce((left, right) => (leaves(right) > leaves(left) ? right : left)).id,
  );
}

/** The pinned configuration of section 5.2; its canonical JSON is hashed as in B0 section 7. */
export function scenarioConfig(profile: Profile) {
  const native = ratioModeConfig(profile);
  const b0 = b0ScenarioConfig(profile);
  return {
    scenario: { id: WASM_SCENARIO_ID, version: WASM_SCENARIO_VERSION },
    runner: WASM_RUNNER_VERSION,
    profile,
    corpus: {
      sha256: CORPUS_SHA256,
      cells: 'the 34 decision cells, paths 0-9, decoded in the page outside timing',
      requests: { fillRule: 'nonzero', toleranceExponent: -3, requestId: 'the path index' },
    },
    operation: {
      id: OPERATION_ID,
      revision: OPERATION_REVISION,
      portVersion: 0,
      transportVersion: 0,
      port: 'createFillMeshPort(WebAssembly.Module) of packages/geometry-wasm, one adapter per page',
      wasm: 'release wasm32-unknown-unknown build of the kernel, SHA-256 verified in the page',
    },
    browser: {
      projects: BROWSER_PROJECTS,
      channels: { chrome: 'chrome', edge: 'msedge' },
      order: 'native leg, then Chrome, then Edge, in one runner session',
      headed: true,
      workers: 1,
      freshPagePerRepetition: true,
      devtools: false,
      tracing: false,
      video: false,
      viewport: { width: 1280, height: 720, deviceScaleFactor: 1 },
      crossOriginIsolated: true,
      page: 'Vite production build of tests/geometry-benchmark/p3-b0-wasm',
    },
    sampling: {
      repetitions: native.sampling.repetitions,
      warmup: native.sampling.warmup,
      timed: native.sampling.timed,
      calls: native.calls,
      onePath: native.onePath,
      preparation:
        'one untimed sample of the same calls per cell before its warm-up; the arenas are provisioned there',
      order: native.order,
      window:
        'from before the first buildFillMeshes call to after the last call fold; one fold per call',
      fold: native.fold,
      integrity:
        'each warm-up and timed sample advances the fill memory epoch by exactly its call count and leaves both arena capacities and the linear memory size unchanged',
      visibility: 'the page stays visible for the whole repetition',
    },
    clock: {
      probe: 'the minimum positive performance.now increment, observed before sampling (P2.5)',
      quantumMultiple: b0.decision.quantumMultiple,
    },
    ratio: {
      perPath:
        'nearest-rank median timed sample / (calls * paths per call), per cell and repetition',
      r: 'browser per-path median / native per-path median, per cell and repetition index',
      kCell: 'nearest-rank median of r over the repetitions, per browser and cell',
      kHat: 'maximum over Chrome and Edge of k_cell at the largest cell of each primary series',
      kHatOnePath: 'the same over the one-path cells; report-only, outside the verdict',
      largestCells: largestCells(),
      label: K_LABEL,
    },
    native,
    decision: {
      rule: 'B0 section 5 with k = k̂ (productVerdict of the AL-S1 analysis)',
      budgets: b0.decision.budgets,
      workloadPaths: b0.decision.workloadPaths,
      alS1: {
        scenario: { id: LADDER_SCENARIO_ID, version: LADDER_SCENARIO_VERSION },
        profile: 'reference',
        record:
          'the one committed docs/benchmarks/results/*_p3_p3-fill-ladder-v1_*.json reference record',
      },
    },
    memory: {
      observation: 'linearMemoryBytes() after the run, per browser',
      ceilingBytes: MEMORY_CEILING_BYTES,
      decisionInput: false,
    },
  };
}

export type WasmConfig = ReturnType<typeof scenarioConfig>;

/** The page options of a repetition, derived from the configuration. */
export function pageOptions(
  config: WasmConfig,
  wasmSha256: string,
): Omit<WasmPageOptions, 'repetition'> {
  return {
    profile: config.profile,
    expectedWasmSha256: wasmSha256,
    expectedCorpusSha256: config.corpus.sha256,
    warmup: config.sampling.warmup,
    timed: config.sampling.timed,
    calls: config.sampling.calls,
    onePathCalls: config.sampling.onePath.calls,
    onePathCells: config.sampling.onePath.cells,
  };
}

// ------------------------------------------------------------------------------------------
// Record types.

export interface BrowserRecord {
  readonly schema: 'p3-b0-wasm-browser/v1';
  readonly project: string;
  readonly channel: string | null;
  readonly browserVersion: string;
  readonly launchFlags: readonly string[];
  readonly repetition: number;
  readonly startedAt: string;
  readonly recordedAt: string;
  readonly instrumentation: Readonly<Record<string, boolean>>;
  readonly capture: WasmCapture | null;
  readonly error: string | null;
}

export interface NativeLeg {
  readonly config: ReturnType<typeof ratioModeConfig>;
  readonly configHash: string;
  readonly toolchain: Readonly<Record<string, string>>;
  readonly build: {
    readonly command: string;
    readonly targetDirectory: string;
    readonly rustflags: readonly string[];
  };
  readonly corpus: { readonly sha256: string; readonly bytes: number };
  readonly repetitions: readonly RatioOutput[];
  readonly failures: readonly { stage: string; error: string; log: string }[];
}

/** The parts of the AL-S1 analysis the product verdict reads. */
export type AlS1Analysis = Pick<
  LadderAnalysis,
  'estimates' | 'checks' | 'invalidReasons' | 'verdict'
>;

export interface AlS1Link {
  readonly path: string;
  readonly sha256: string;
  readonly runId: string | null;
  readonly scenario: { readonly id: string; readonly version: number };
  readonly profile: string;
  readonly configHash: string;
  readonly analysis: AlS1Analysis;
}

export interface WasmRecord {
  readonly schemaVersion: 1;
  readonly scenario: {
    readonly id: string;
    readonly version: number;
    readonly profile: Profile;
    readonly config: WasmConfig;
    readonly configHash: string;
  };
  readonly run: Readonly<Record<string, unknown>>;
  readonly environment: Readonly<Record<string, unknown>>;
  readonly builds: {
    readonly wasm: { readonly sha256: string; readonly bytes: number } & Readonly<
      Record<string, unknown>
    >;
  } & Readonly<Record<string, unknown>>;
  readonly corpus: { readonly sha256: string; readonly bytes: number };
  readonly native: NativeLeg | null;
  readonly browsers: readonly BrowserRecord[];
  readonly alS1: AlS1Link | null;
  readonly failures: readonly { readonly stage: string; readonly error: string }[];
  readonly analysis?: unknown;
}

// ------------------------------------------------------------------------------------------
// The AL-S1 link.

export function sha256Hex(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Builds the link to a committed AL-S1 record from its repository path and file bytes. */
export function linkAlS1(repositoryPath: string, bytes: Uint8Array): AlS1Link {
  const record = JSON.parse(new TextDecoder().decode(bytes)) as LadderRecord & {
    analysis: LadderAnalysis;
  };
  const analysis = record.analysis;
  const runId = (record.run as { runId?: unknown }).runId;
  return {
    path: repositoryPath,
    sha256: sha256Hex(bytes),
    runId: typeof runId === 'string' ? runId : null,
    scenario: { id: record.scenario.id, version: record.scenario.version },
    profile: record.scenario.profile,
    configHash: record.scenario.configHash,
    analysis: {
      estimates: analysis.estimates,
      checks: analysis.checks,
      invalidReasons: analysis.invalidReasons,
      verdict: analysis.verdict,
    },
  };
}

// ------------------------------------------------------------------------------------------
// Analysis.

interface CellRepetition {
  readonly repetition: number;
  readonly perPathMedianNs: number;
  readonly unverified: boolean;
}

interface CellTable {
  readonly cell: string;
  readonly checksum: string | null;
  readonly admitted: boolean;
  readonly perRepetition: readonly CellRepetition[];
}

const median = (values: readonly number[]) =>
  nearestRank(
    [...values].sort((left, right) => left - right),
    0.5,
  );

function browserTable(
  captures: readonly { repetition: number; capture: WasmCapture }[],
  ids: readonly string[],
  pick: (capture: WasmCapture) => readonly WasmCellCapture[],
  calls: number,
  paths: number,
  config: WasmConfig,
  issues: string[],
): CellTable[] {
  return ids.map((id) => {
    const checksums = new Set<string>();
    let admitted = captures.length > 0;
    const perRepetition = captures.flatMap(({ repetition, capture }) => {
      const entry = pick(capture).find((item) => item.cell === id);
      if (!entry || entry.timed.length === 0) {
        issues.push(`r${repetition}:${id} missing`);
        admitted = false;
        return [];
      }
      if (entry.calls !== calls || entry.paths !== paths)
        issues.push(`r${repetition}:${id} call or path count`);
      if (
        entry.timed.length !== config.sampling.timed ||
        entry.warmup.length !== config.sampling.warmup
      )
        issues.push(`r${repetition}:${id} sample counts`);
      if (entry.statuses.length !== paths || entry.statuses.some((status) => status !== 'ok'))
        admitted = false;
      for (const item of [entry.preparation, ...entry.warmup, ...entry.timed])
        checksums.add(item.checksum);
      for (const item of [...entry.warmup, ...entry.timed])
        if (item.epochDelta !== calls || !item.storageStable || item.batchFailures !== 0)
          issues.push(`r${repetition}:${id} reserve, growth or retry during a sample`);
      const quantumMs = capture.clockProbe.minimumQuantumMs;
      const timedMs = entry.timed.map((item) => item.ms);
      return [
        {
          repetition,
          perPathMedianNs: (median(timedMs) * 1e6) / (calls * paths),
          unverified:
            quantumMs === null ||
            timedMs.some((ms) => ms < config.clock.quantumMultiple * quantumMs),
        },
      ];
    });
    if (checksums.size !== 1) issues.push(`${id} browser checksums ${checksums.size}`);
    return {
      cell: id,
      checksum: checksums.size === 1 ? [...checksums][0]! : null,
      admitted,
      perRepetition,
    };
  });
}

interface RatioCell {
  readonly cell: string;
  readonly perRepetition: readonly { readonly repetition: number; readonly r: number }[];
  readonly kCell: number | null;
}

function ratioTable(
  browser: readonly CellTable[],
  native: readonly {
    cell: string;
    perRepetition: readonly { repetition: number; perPathMedianNs: number }[];
  }[],
): RatioCell[] {
  return browser.map((entry) => {
    const nativeEntry = native.find((item) => item.cell === entry.cell);
    const perRepetition = entry.perRepetition.flatMap((item) => {
      const nativeItem = nativeEntry?.perRepetition.find(
        (candidate) => candidate.repetition === item.repetition,
      );
      return nativeItem === undefined || nativeItem.perPathMedianNs <= 0
        ? []
        : [{ repetition: item.repetition, r: item.perPathMedianNs / nativeItem.perPathMedianNs }];
    });
    return {
      cell: entry.cell,
      perRepetition,
      kCell: perRepetition.length === 0 ? null : median(perRepetition.map((item) => item.r)),
    };
  });
}

function maximum(values: readonly (number | null)[]): number | null {
  if (values.length === 0 || values.some((value) => value === null)) return null;
  return Math.max(...(values as number[]));
}

export type ProductVerdictName = 'NONE' | 'INVALID' | 'FEASIBLE' | 'INFEASIBLE' | 'INCONCLUSIVE';

type Product = ReturnType<typeof productVerdict>;

/**
 * The combined verdict of section 5.3: AL-S1's estimates with k = k̂ under B0's rule, through
 * AL-U5's `productVerdict`. `s2Invalid` (a browser/native checksum mismatch) yields INVALID,
 * no verdict; `s2Valid` false (any other AL-S2 validity item) yields INCONCLUSIVE; a
 * functional run has none (NONE). A reference record without a usable AL-S1 link is
 * INCONCLUSIVE, since its metadata check also fails.
 */
export function combinedVerdict(
  profile: Profile,
  link: AlS1Link | null,
  config: WasmConfig,
  kHat: number | null,
  kHatOnePath: number | null,
  s2Invalid: boolean,
  s2Valid: boolean,
): {
  verdict: ProductVerdictName;
  reason: string;
  estimates: Product['estimates'];
  ratios: Product['ratios'];
} {
  const linkIssue =
    link === null
      ? 'no linked AL-S1 record'
      : link.scenario.id !== config.decision.alS1.scenario.id ||
          link.scenario.version !== config.decision.alS1.scenario.version
        ? 'the linked record is not AL-S1 v1'
        : link.profile !== 'reference'
          ? 'the linked AL-S1 record is not a reference record'
          : null;
  const computed =
    link === null || linkIssue !== null
      ? null
      : productVerdict(
          link.analysis,
          kHat ?? Number.NaN,
          { invalid: s2Invalid, valid: s2Valid },
          kHatOnePath,
        );
  const estimates = computed?.estimates ?? null;
  const ratios = computed?.ratios ?? null;
  // An AL-S2 functional run has no verdict whatever the linked AL-S1 record says.
  if (profile !== 'reference')
    return { verdict: 'NONE', reason: 'functional profile', estimates, ratios };
  if (computed === null)
    return s2Invalid
      ? {
          verdict: 'INVALID',
          reason: 'a browser checksum differs from the native checksum',
          estimates,
          ratios,
        }
      : { verdict: 'INCONCLUSIVE', reason: linkIssue!, estimates, ratios };
  const reasons: Record<ProductVerdictName, string> = {
    NONE: 'the linked AL-S1 record has no verdict',
    INVALID: s2Invalid
      ? 'a browser checksum differs from the native checksum'
      : `AL-S1 invalid: ${link!.analysis.invalidReasons.join(', ')}`,
    INCONCLUSIVE: s2Valid ? 'an AL-S1 check fails' : 'an AL-S2 validity item fails',
    FEASIBLE: 'B0 rule with k = k̂',
    INFEASIBLE: 'B0 rule with k = k̂',
  };
  return { verdict: computed.verdict, reason: reasons[computed.verdict], estimates, ratios };
}

export function analyze(record: WasmRecord) {
  const config = record.scenario.config;
  const decision = corpusCells()
    .filter((cell) => cell.role === 'decision')
    .map((cell) => cell.id);
  const largest = config.ratio.largestCells;
  const onePathCells = config.sampling.onePath.cells;

  const native =
    record.native === null
      ? null
      : analyzeRatioNative(record.native.repetitions, record.native.config);

  const browsers = BROWSER_PROJECTS.map((project) => {
    const issues: string[] = [];
    const records = record.browsers
      .filter((item) => item.project === project)
      .sort((left, right) => left.repetition - right.repetition);
    const captures: { repetition: number; capture: WasmCapture }[] = [];
    for (let repetition = 0; repetition < config.sampling.repetitions; repetition += 1) {
      const item = records.filter((candidate) => candidate.repetition === repetition);
      if (item.length !== 1) {
        issues.push(`r${repetition} ${item.length} records`);
        continue;
      }
      const { capture, error } = item[0]!;
      if (error !== null || capture === null) {
        issues.push(`r${repetition} failed: ${error ?? 'no capture'}`);
        continue;
      }
      if (capture.errors.length > 0) issues.push(`r${repetition} errors`);
      captures.push({ repetition, capture });
    }
    if (records.length !== config.sampling.repetitions)
      issues.push(`${records.length} of ${config.sampling.repetitions} repetitions`);
    const identityIssues: string[] = [];
    for (const { repetition, capture } of captures) {
      const expected = { ...pageOptions(config, record.builds.wasm.sha256), repetition };
      if (canonicalJson(capture.options) !== canonicalJson(expected))
        identityIssues.push(`r${repetition} page options`);
      if (capture.wasmSha256 !== record.builds.wasm.sha256)
        identityIssues.push(`r${repetition} WASM SHA-256`);
      if (capture.corpusSha256 !== config.corpus.sha256)
        identityIssues.push(`r${repetition} corpus SHA-256`);
      if (
        capture.adapter?.operationId !== config.operation.id ||
        capture.adapter.portVersion !== config.operation.portVersion
      )
        identityIssues.push(`r${repetition} adapter identity`);
    }
    const tableIssues: string[] = [];
    const tenPath = browserTable(
      captures,
      decision,
      (capture) => capture.cells,
      config.sampling.calls,
      DECISION_PATHS,
      config,
      tableIssues,
    );
    const onePath = browserTable(
      captures,
      onePathCells,
      (capture) => capture.onePath,
      config.sampling.onePath.calls,
      1,
      config,
      tableIssues,
    );
    const ratios = native === null ? [] : ratioTable(tenPath, native.tenPath);
    const onePathRatios = native === null ? [] : ratioTable(onePath, native.onePath);
    const memory = captures.map((item) => item.capture.linearMemoryBytes);
    const linearMemoryBytes = memory.length === 0 ? null : maximum(memory);
    return {
      project,
      browserVersions: [...new Set(records.map((item) => item.browserVersion))],
      crossOriginIsolated: captures.every((item) => item.capture.crossOriginIsolated),
      clockQuantumMs: captures.map((item) => item.capture.clockProbe.minimumQuantumMs),
      issues,
      identityIssues,
      tableIssues,
      tenPath,
      onePath,
      ratios,
      onePathRatios,
      linearMemoryBytes,
    };
  });

  const kAt = (pick: (browser: (typeof browsers)[number]) => RatioCell[], ids: readonly string[]) =>
    maximum(
      browsers.flatMap((browser) =>
        ids.map((id) => pick(browser).find((item) => item.cell === id)?.kCell ?? null),
      ),
    );
  const kHat = native === null ? null : kAt((browser) => browser.ratios, largest);
  const kHatOnePath =
    native === null ? null : kAt((browser) => browser.onePathRatios, onePathCells);

  // Validity, all required (section 5.2).
  const checks: { id: ValidityId; pass: boolean; detail: string }[] = [];
  const check = (id: ValidityId, pass: boolean, detail: string) =>
    checks.push({ id, pass, detail });
  const complete = [
    ...(record.native === null ? ['native leg missing'] : []),
    ...(record.native?.failures ?? []).map((item) => `native ${item.stage}`),
    ...(record.native !== null && record.native.repetitions.length !== config.sampling.repetitions
      ? [`native ${record.native.repetitions.length} repetitions`]
      : []),
    ...browsers.flatMap((browser) => browser.issues.map((item) => `${browser.project} ${item}`)),
    ...record.failures.map((item) => item.stage),
  ];
  check('repetitions-complete', complete.length === 0, complete.join('; ') || 'complete');

  const mismatches: string[] = [];
  for (const browser of browsers) {
    for (const [table, nativeTable] of [
      [browser.tenPath, native?.tenPath ?? []],
      [browser.onePath, native?.onePath ?? []],
    ] as const) {
      for (const entry of table) {
        const nativeChecksum = nativeTable.find((item) => item.cell === entry.cell)?.checksum;
        if (entry.checksum === null || nativeChecksum == null || entry.checksum !== nativeChecksum)
          mismatches.push(`${browser.project} ${entry.cell}`);
      }
    }
  }
  if (native === null) mismatches.push('no native checksums');
  check(
    'checksums-equal-native',
    mismatches.length === 0,
    mismatches.join(', ') || 'every browser cell checksum equals the native checksum',
  );

  const unverified = browsers.flatMap((browser) =>
    largest
      .filter(
        (id) =>
          browser.tenPath
            .find((item) => item.cell === id)
            ?.perRepetition.some((item) => item.unverified) ?? true,
      )
      .map((id) => `${browser.project} ${id}`),
  );
  const nativeUnverified = (native?.issues ?? []).filter((item) => item.startsWith('UNVERIFIED'));
  check(
    'largest-primary-verified',
    unverified.length === 0 && nativeUnverified.length === 0 && native !== null,
    [...unverified, ...nativeUnverified].join(', ') || 'no largest primary cell is UNVERIFIED',
  );

  const growth = [
    ...browsers.flatMap((browser) =>
      browser.tableIssues
        .filter((item) => item.includes('reserve'))
        .map((item) => `${browser.project} ${item}`),
    ),
    ...(native?.issues ?? []).filter(
      (item) => item.includes('allocates') || item.includes('storage moved'),
    ),
  ];
  check('no-reserve-or-growth', growth.length === 0, growth.join(', ') || 'none during timing');

  const notAdmitted = browsers.flatMap((browser) =>
    largest
      .filter((id) => !browser.tenPath.find((item) => item.cell === id)?.admitted)
      .map((id) => `${browser.project} ${id}`),
  );
  check(
    'largest-cells-admitted',
    notAdmitted.length === 0,
    notAdmitted.join(', ') || 'every path of every largest primary cell is ok',
  );

  const identity = [
    ...browsers.flatMap((browser) =>
      [
        ...browser.identityIssues,
        ...browser.tableIssues.filter((item) => !item.includes('reserve')),
      ].map((item) => `${browser.project} ${item}`),
    ),
    ...(record.corpus.sha256 === config.corpus.sha256 ? [] : ['corpus SHA-256']),
    ...(record.native !== null && record.native.corpus.sha256 !== config.corpus.sha256
      ? ['native corpus SHA-256']
      : []),
  ];
  check('operation-identity', identity.length === 0, identity.join('; ') || 'identical');

  check(
    'native-leg-valid',
    native !== null && native.valid,
    native === null ? 'missing' : native.issues.join(', ') || 'valid',
  );

  const run = record.run as Record<string, unknown>;
  const environment = record.environment as Record<string, unknown>;
  const missing = [
    ['run.commit', run.commit],
    ['run.utcStart', run.utcStart],
    ['run.timezone', run.timezone],
    ['environment.os', environment.os],
    ['environment.cpu', environment.cpu],
    // A functional run cannot claim reference observations (B0's argument rule).
    ...(record.scenario.profile === 'reference'
      ? [
          ['environment.power', environment.power],
          ['environment.backgroundLoad', environment.backgroundLoad],
        ]
      : []),
    ['builds.wasm.sha256', record.builds.wasm.sha256],
    ['builds.page', record.builds.page],
    ['native.toolchain', record.native?.toolchain],
    ...browsers.flatMap((browser) => [
      [`${browser.project}.browserVersion`, browser.browserVersions[0]],
      [`${browser.project}.linearMemoryBytes`, browser.linearMemoryBytes],
    ]),
    ...(record.scenario.profile === 'reference' ? [['alS1', record.alS1]] : []),
  ]
    .filter(([, value]) => value === undefined || value === null || value === '')
    .map(([name]) => name as string);
  check('metadata-complete', missing.length === 0, missing.join(', ') || 'complete');

  const valid = checks.every((item) => item.pass);
  // Section 5.3: a checksum mismatch leaves the run with no verdict (INVALID); every other
  // validity failure makes it INCONCLUSIVE. The two signals reach the verdict separately.
  const s2Invalid = !checks.find((item) => item.id === 'checksums-equal-native')!.pass;
  const s2Valid = checks
    .filter((item) => item.id !== 'checksums-equal-native')
    .every((item) => item.pass);
  const product = combinedVerdict(
    record.scenario.profile,
    record.alS1,
    config,
    kHat,
    kHatOnePath,
    s2Invalid,
    s2Valid,
  );

  const memory = browsers.map((browser) => ({
    project: browser.project,
    linearMemoryBytes: browser.linearMemoryBytes,
    withinCeiling:
      browser.linearMemoryBytes === null
        ? null
        : browser.linearMemoryBytes <= config.memory.ceilingBytes,
  }));

  return {
    native,
    browsers,
    kHat,
    kHatOnePath,
    kLabel: K_LABEL,
    largestCells: largest,
    checks,
    valid,
    memory,
    product,
  };
}

export type WasmAnalysis = ReturnType<typeof analyze>;

/**
 * Rejects a record whose identity, pinned configuration, hashes, AL-S1 link or stored analysis
 * differs. `alS1Bytes` are the bytes of the linked AL-S1 file (null when the record links
 * none); `validateAlS1` re-validates that record (AL-U5's `validateLadderRecord` by default).
 */
export function validateWasmRecord(
  record: WasmRecord,
  alS1Bytes: Uint8Array | null,
  validateAlS1: (record: LadderRecord) => void = validateLadderRecord,
): void {
  if (record.schemaVersion !== WASM_SCHEMA_VERSION) throw new Error('unsupported schema version');
  if (record.scenario.id !== WASM_SCENARIO_ID || record.scenario.version !== WASM_SCENARIO_VERSION)
    throw new Error('scenario identity mismatch');
  if (configHash(record.scenario.config) !== record.scenario.configHash)
    throw new Error('configuration hash mismatch');
  if (
    canonicalJson(record.scenario.config) !== canonicalJson(scenarioConfig(record.scenario.profile))
  )
    throw new Error('configuration differs from scenarioConfig');
  if (record.corpus.sha256 !== CORPUS_SHA256) throw new Error('corpus hash mismatch');
  if (record.native !== null) {
    if (canonicalJson(record.native.config) !== canonicalJson(record.scenario.config.native))
      throw new Error('native configuration differs from the pinned ratio mode');
    if (configHash(record.native.config) !== record.native.configHash)
      throw new Error('native configuration hash mismatch');
  }
  if (record.alS1 !== null) {
    if (alS1Bytes === null) throw new Error('the linked AL-S1 record is required');
    if (sha256Hex(alS1Bytes) !== record.alS1.sha256) throw new Error('AL-S1 record hash mismatch');
    validateAlS1(JSON.parse(new TextDecoder().decode(alS1Bytes)) as LadderRecord);
    if (canonicalJson(linkAlS1(record.alS1.path, alS1Bytes)) !== canonicalJson(record.alS1))
      throw new Error('AL-S1 link differs from the linked record');
  } else if (alS1Bytes !== null) throw new Error('AL-S1 bytes given for a record without a link');
  if (canonicalJson(analyze(record)) !== canonicalJson(record.analysis))
    throw new Error('stored analysis differs from the recomputation');
}
