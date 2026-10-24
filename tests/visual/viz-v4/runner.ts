// V-4 unit VZ4-U2: the A08 offline metrics runner (docs/plans/viz-v4-a08-corpus-contract.md,
// sections 4.4, 5 and 6). It loads a headed run directory written by
// tests/gpu/viz-v4-a08-corpus.spec.ts, the expected-status list of section 5.1 and the subset;
// regenerates each case's mesh in Node through E3's `drawCase` with the recording ports
// (VZ4-A4); checks completeness (VZ4-A3); judges every RENDERED case (metrics.ts, section 5.2);
// checks VZ4-A5 on `msaa-4x`; applies the section 5.3 verdict; and writes a deterministic
// `record.json` and a short `record.md`, labelled PRE-FREEZE unless told otherwise (VZ4-A11).
// `replayRecord` re-evaluates a record's inputs and requires byte-identical output (VZ4-A9).
// `runMetrics` and `replayRecord` refuse before the E3 freeze record (E3 section 5.5), because
// they run the kernel on corpus cases; `evaluateRun` itself takes its ports from the caller, so
// unit tests drive it with scripted ports only.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import type { FillMeshPort, StrokeMeshPort } from '@vector-studio/contracts';

import type { PathDrawRecordForTesting } from '../../../packages/renderer-core/src/path-mesh-pipeline.js';
import { physicalSize, type VizV4MeshCall } from '../../../apps/playground/src/viz-v4-a08-cases.js';
import { decodeRleBase64 } from '../../geometry/coverage-oracle/rle.js';
import { drawCase, type DrawOutcome } from '../../geometry/e3-a04/harness.js';
import {
  a04FreezeRecorded,
  callKey,
  recordingPorts,
  VIZ_V4_VARIANTS,
  variantQuery,
  type ExpectedEntry,
  type VizV4Status,
  type VizV4Variant,
} from './cases.js';
import {
  buildReference,
  evaluateCapture,
  ruleAccumulators,
  type CaseMetrics,
  type Judgment,
  type Reference,
  type RuleAccumulators,
} from './metrics.js';
import {
  A08_DPRS,
  A08_GATED_DPRS,
  summarizeA08Subset,
  type A08Case,
  type A08Dpr,
} from './subset.js';

export const RECORD_VERSION = 'viz-v4-metrics/v1';
export const CONTRACT = 'docs/plans/viz-v4-a08-corpus-contract.md';
export const DEFAULT_LABEL = 'PRE-FREEZE';
/** VZ4-Q6: more than 5 % of the gated cases expected RENDERED not RENDERED is INCONCLUSIVE. */
export const NOT_RENDERED_LIMIT = Object.freeze({ num: 5, den: 100 });
const GATED_VARIANTS: readonly VizV4Variant[] = ['fringe-1x', 'fringe-4x'];
/** The headed browsers, by their playwright.gpu.config.ts project names (VZ4-A1, VZ4-A3). */
export const A08_PROJECTS: readonly string[] = ['chrome', 'edge'];
const STATUSES: readonly VizV4Status[] = [
  'RENDERED',
  'KERNEL-REJECTED',
  'REGION-ONLY',
  'EMPTY-CROP',
  'MESH-MISMATCH',
  'RENDERER-FAILED',
];
/** How many entries a record list keeps in full in record.md. */
const MD_LIMIT = 20;

export type Ports = Readonly<{ fill: FillMeshPort; stroke: StrokeMeshPort }>;

/** One line of observations.ndjson, as the spec writes it. */
export type Observation = Readonly<{
  key: string;
  a04Id: string;
  part: string;
  gated: boolean;
  status: VizV4Status;
  reason: string;
  expected: VizV4Status;
  width: number;
  height: number;
  sampleCount: number;
  devicePixelRatio: number;
  meshTriangles: number;
  record: PathDrawRecordForTesting | null;
  notices: readonly string[];
  meshCalls: readonly VizV4MeshCall[];
  notGreyPixels: number;
  red: string;
  counts: Readonly<{ samples: number; rle: string }>;
}>;

export type ExpectedFile = Readonly<{
  version: string;
  subsetKeysSha256: string;
  wasmSha256: string;
  statuses: Readonly<Record<string, Readonly<Record<VizV4Variant, ExpectedEntry>>>>;
}>;

export type RunGroup = Readonly<{
  project: string;
  variant: VizV4Variant;
  dpr: A08Dpr;
  meta: Readonly<Record<string, unknown>>;
  observations: readonly Observation[];
}>;

export type LoadedRun = Readonly<{
  projects: readonly string[];
  groups: readonly RunGroup[];
  /** SHA-256 of every input file, keyed by its path relative to the run directory. */
  files: Readonly<Record<string, string>>;
}>;

function sha256(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

export function groupPath(project: string, variant: string, dpr: number): string {
  return `${project}/${variant}/dpr${String(dpr)}`;
}

/** Parses observations.ndjson text. */
export function parseObservations(text: string): Observation[] {
  return text
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Observation);
}

/** Loads `<run>/<project>/<variant>/dpr<D>/{meta.json, observations.ndjson}`. */
export function loadRun(dir: string): LoadedRun {
  if (!existsSync(dir)) throw new Error(`viz-v4 metrics: no run directory ${dir}`);
  const projects = readdirSync(dir)
    .filter((name) => statSync(path.join(dir, name)).isDirectory())
    .sort();
  const groups: RunGroup[] = [];
  const files: Record<string, string> = {};
  for (const project of projects)
    for (const variant of VIZ_V4_VARIANTS)
      for (const dpr of A08_DPRS) {
        const relative = groupPath(project, variant, dpr);
        const metaPath = path.join(dir, relative, 'meta.json');
        const observationsPath = path.join(dir, relative, 'observations.ndjson');
        if (!existsSync(metaPath) || !existsSync(observationsPath)) continue;
        const metaText = readFileSync(metaPath);
        const observationText = readFileSync(observationsPath);
        files[`${relative}/meta.json`] = sha256(metaText);
        files[`${relative}/observations.ndjson`] = sha256(observationText);
        groups.push({
          project,
          variant,
          dpr,
          meta: JSON.parse(metaText.toString('utf8')) as Record<string, unknown>,
          observations: parseObservations(observationText.toString('utf8')),
        });
      }
  return { projects, groups, files };
}

// =============================================================================================
// Deterministic JSON

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort())
      out[key] = canonicalValue((value as Record<string, unknown>)[key]);
    return out;
  }
  if (typeof value === 'number' && !Number.isFinite(value))
    throw new Error('viz-v4 metrics: a non-finite number in the record');
  return value;
}

/** JSON with every object's keys in code-unit order and no whitespace. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

// =============================================================================================
// The verdict (section 5.3)

export type VerdictEntry = Readonly<{
  project: string;
  key: string;
  variant: VizV4Variant;
  dpr: A08Dpr;
  gated: boolean;
  expected: Readonly<{ status: VizV4Status; reason: string }>;
  /** The headed status after the runner's VZ4-A4 check; null when the case is missing. */
  headed: VizV4Status | null;
  headedReason: string;
  judgment: Judgment | null;
  reasons: readonly string[];
}>;

export type VerdictResult = 'PASS' | 'FAIL' | 'INCONCLUSIVE';

export type Verdict = Readonly<{
  result: VerdictResult;
  /** The INCONCLUSIVE conditions that hold, in the contract's order. */
  inconclusive: readonly string[];
  failing: readonly Readonly<{
    project: string;
    key: string;
    variant: string;
    gates: readonly string[];
  }>[];
  undecided: readonly Readonly<{
    project: string;
    key: string;
    variant: string;
    reasons: readonly string[];
  }>[];
  notRendered: readonly Readonly<{
    project: string;
    dpr: number;
    expectedRendered: number;
    notRendered: number;
    exceeds: boolean;
  }>[];
  deviations: readonly Readonly<{
    project: string;
    key: string;
    variant: string;
    expected: string;
    headed: string | null;
  }>[];
  flagged: readonly Readonly<{
    source: 'expected' | 'headed';
    project: string | null;
    key: string;
    variant: string;
    status: string;
    reason: string;
  }>[];
}>;

const flaggedStatus = (status: VizV4Status | null, reason: string) =>
  status === 'RENDERER-FAILED' || (status === 'EMPTY-CROP' && reason === 'port-empty');

/**
 * Section 5.3: FAIL when any gated case FAILS (FAIL outranks INCONCLUSIVE, decided 2026-10-24
 * under the standing instruction, review round 1 S2). Otherwise INCONCLUSIVE when any gated case
 * is UNDECIDED, when more than 5 % of the gated cases expected RENDERED are not RENDERED at a gated
 * DPR in a browser (both fringe variants pooled), when a headed status differs from the expected
 * list, or when a gated case is RENDERER-FAILED or `port-empty` EMPTY-CROP in the list or the
 * headed run. Otherwise PASS. The INCONCLUSIVE conditions are reported either way.
 */
export function decideVerdict(
  entries: readonly VerdictEntry[],
  projects: readonly string[],
): Verdict {
  const gated = entries.filter((e) => e.gated && GATED_VARIANTS.includes(e.variant));
  const failing = gated
    .filter((e) => e.judgment === 'FAIL')
    .map((e) => ({ project: e.project, key: e.key, variant: e.variant, gates: e.reasons }));
  const undecided = gated
    .filter((e) => e.judgment === 'UNDECIDED')
    .map((e) => ({ project: e.project, key: e.key, variant: e.variant, reasons: e.reasons }));
  const notRendered = projects.flatMap((project) =>
    A08_GATED_DPRS.map((dpr) => {
      const pool = gated.filter(
        (e) => e.project === project && e.dpr === dpr && e.expected.status === 'RENDERED',
      );
      const missing = pool.filter((e) => e.headed !== 'RENDERED').length;
      return {
        project,
        dpr,
        expectedRendered: pool.length,
        notRendered: missing,
        exceeds: missing * NOT_RENDERED_LIMIT.den > NOT_RENDERED_LIMIT.num * pool.length,
      };
    }),
  );
  const deviations = entries
    .filter((e) => e.headed !== e.expected.status)
    .map((e) => ({
      project: e.project,
      key: e.key,
      variant: e.variant,
      expected: e.expected.status,
      headed: e.headed,
    }));
  const flagged: Verdict['flagged'][number][] = [];
  const listed = new Set<string>();
  for (const e of gated) {
    const id = `${e.key}|${e.variant}`;
    if (!listed.has(id) && flaggedStatus(e.expected.status, e.expected.reason)) {
      listed.add(id);
      flagged.push({
        source: 'expected',
        project: null,
        key: e.key,
        variant: e.variant,
        status: e.expected.status,
        reason: e.expected.reason,
      });
    }
    if (flaggedStatus(e.headed, e.headedReason))
      flagged.push({
        source: 'headed',
        project: e.project,
        key: e.key,
        variant: e.variant,
        status: e.headed!,
        reason: e.headedReason,
      });
  }
  const inconclusive: string[] = [];
  if (undecided.length > 0) inconclusive.push('gated case UNDECIDED');
  if (notRendered.some((n) => n.exceeds)) inconclusive.push('more than 5 % not RENDERED');
  if (deviations.length > 0) inconclusive.push('headed status differs from the expected list');
  if (flagged.length > 0) inconclusive.push('gated RENDERER-FAILED or port-empty');
  const result: VerdictResult =
    failing.length > 0 ? 'FAIL' : inconclusive.length > 0 ? 'INCONCLUSIVE' : 'PASS';
  return { result, inconclusive, failing, undecided, notRendered, deviations, flagged };
}

// =============================================================================================
// Evaluation

export type RunInput = Readonly<{
  run: LoadedRun;
  expected: ExpectedFile;
  expectedSha256: string;
  subset: readonly A08Case[];
  ports: Ports;
  wasmSha256: string;
  label: string;
}>;

type CaseEntry = Readonly<{
  project: string;
  key: string;
  part: string;
  variant: VizV4Variant;
  dpr: A08Dpr;
  gated: boolean;
  expected: VizV4Status;
  headed: VizV4Status | null;
  status: VizV4Status | null;
  reason: string;
  judgment: Judgment | null;
  reasons: readonly string[];
  notGreyPixels: number | null;
  metrics: CaseMetrics | null;
}>;

type Criterion = Readonly<{ result: 'PASS' | 'FAIL' | 'UNDECIDED'; [k: string]: unknown }>;

export type RecordBody = Readonly<{
  version: string;
  label: string;
  contract: string;
  inputs: Readonly<Record<string, unknown>>;
  result: VerdictResult;
  verdict: Verdict;
  criteria: Readonly<Record<string, Criterion>>;
  report: Readonly<Record<string, unknown>>;
  cases: readonly CaseEntry[];
}>;

type NodeSide = Readonly<{ calls: readonly string[]; outcome: DrawOutcome }>;

function nodeSide(c: A08Case, ports: Ports, variant: VizV4Variant): NodeSide {
  const recorder = recordingPorts(ports);
  const outcome = drawCase(c.kase, recorder.ports, { fringe: variantQuery(variant).fringe });
  return { calls: recorder.take().map(callKey).sort(), outcome };
}

type Tally = {
  cases: number;
  statuses: Record<string, number>;
  judgments: Record<string, number>;
  g1: { fail: number; undecided: number; maxInsideError: number; maxOutsideError: number };
  g2: { misclassified: number; fail: number; undecided: number };
  g3: { fullFail: number; otherFail: number; maxCount: number };
  a5: { interiorPixels: number; violations: number; crackExcluded: number };
  cracks: { casesWithTJunctions: number; zonePixels: number; pixels: number };
  rule: RuleAccumulators;
};

function tally(): Tally {
  return {
    cases: 0,
    statuses: {},
    judgments: {},
    g1: { fail: 0, undecided: 0, maxInsideError: 0, maxOutsideError: 0 },
    g2: { misclassified: 0, fail: 0, undecided: 0 },
    g3: { fullFail: 0, otherFail: 0, maxCount: 0 },
    a5: { interiorPixels: 0, violations: 0, crackExcluded: 0 },
    cracks: { casesWithTJunctions: 0, zonePixels: 0, pixels: 0 },
    rule: ruleAccumulators(),
  };
}

function add(t: Tally, entry: CaseEntry, rule: RuleAccumulators | null): void {
  t.cases += 1;
  const status = entry.status ?? 'MISSING';
  t.statuses[status] = (t.statuses[status] ?? 0) + 1;
  if (entry.judgment !== null) t.judgments[entry.judgment] = (t.judgments[entry.judgment] ?? 0) + 1;
  const m = entry.metrics;
  if (m === null) return;
  t.g1.fail += m.g1.fail;
  t.g1.undecided += m.g1.undecided;
  t.g1.maxInsideError = Math.max(t.g1.maxInsideError, m.g1.maxInsideError);
  t.g1.maxOutsideError = Math.max(t.g1.maxOutsideError, m.g1.maxOutsideError);
  t.g2.misclassified += m.g2.misclassified;
  t.g2.fail += m.g2.fail;
  t.g2.undecided += m.g2.undecided;
  t.g3.fullFail += m.g3.fullFail;
  t.g3.otherFail += m.g3.otherFail;
  t.g3.maxCount = Math.max(t.g3.maxCount, m.g3.maxCount);
  t.a5.interiorPixels += m.a5.interiorPixels;
  t.a5.violations += m.a5.violations;
  t.a5.crackExcluded += m.a5.crackExcluded;
  if (m.tJunctionEdges > 0) t.cracks.casesWithTJunctions += 1;
  t.cracks.zonePixels += m.crack.zonePixels;
  t.cracks.pixels += m.crack.pixels;
  if (rule !== null) {
    t.rule.interior.merge(rule.interior);
    t.rule.exterior.merge(rule.exterior);
    t.rule.band.merge(rule.band);
  }
}

function tallyJson(t: Tally) {
  return {
    cases: t.cases,
    statuses: t.statuses,
    judgments: t.judgments,
    g1: t.g1,
    g2: t.g2,
    g3: t.g3,
    a5: t.a5,
    cracks: t.cracks,
    rule: {
      interior: t.rule.interior.result(),
      exterior: t.rule.exterior.result(),
      band: t.rule.band.result(),
    },
  };
}

function criterionFrom(entries: readonly CaseEntry[], gate: 'g12' | 'g3'): Criterion {
  const gated = entries.filter((e) => e.gated && GATED_VARIANTS.includes(e.variant));
  let fail = 0;
  let undecided = 0;
  for (const e of gated) {
    const m = e.metrics;
    if (e.judgment === null) continue;
    if (m === null) {
      if (e.judgment === 'FAIL') fail += 1;
      else if (e.judgment === 'UNDECIDED') undecided += 1;
      continue;
    }
    const failed =
      gate === 'g12'
        ? m.g1.fail + m.g2.fail > 0 || m.pairing !== 'OK'
        : m.g3.fullFail + m.g3.otherFail > 0;
    const open =
      m.noFlip.failed > 0 ||
      m.windingAnomalies > 0 ||
      (gate === 'g12' && m.g1.undecided + m.g2.undecided > 0);
    if (open) undecided += 1;
    else if (failed) fail += 1;
  }
  return {
    result: fail > 0 ? 'FAIL' : undecided > 0 ? 'UNDECIDED' : 'PASS',
    cases: gated.length,
    fail,
    undecided,
  };
}

/** Evaluates a loaded run (sections 4.4 to 5.4). Throws when the inputs do not belong together. */
export function evaluateRun(input: RunInput): RecordBody {
  const { run, expected, subset, ports } = input;
  const summary = summarizeA08Subset(subset);
  if (expected.subsetKeysSha256 !== summary.keysSha256)
    throw new Error('viz-v4 metrics: the expected-status list is for another subset');
  if (expected.wasmSha256 !== input.wasmSha256)
    throw new Error('viz-v4 metrics: the expected-status list was taken on another WASM');
  for (const group of run.groups) {
    const wasm = group.meta['wasmSha256'];
    if (wasm !== undefined && wasm !== input.wasmSha256)
      throw new Error(
        `viz-v4 metrics: ${groupPath(group.project, group.variant, group.dpr)} ran another WASM`,
      );
  }
  const groupOf = new Map<string, RunGroup>();
  for (const group of run.groups)
    groupOf.set(groupPath(group.project, group.variant, group.dpr), group);

  const a3 = {
    missingProjects: A08_PROJECTS.filter((p) => !run.projects.includes(p)),
    missingGroups: [] as string[],
    incompleteGroups: [] as string[],
    missingCases: [] as string[],
    duplicateCases: [] as string[],
    extraCases: [] as string[],
    badStatuses: [] as string[],
  };
  const a4: string[] = [];
  const a5Records: string[] = [];
  const a5Pixels: string[] = [];
  const entries: CaseEntry[] = [];
  const verdictEntries: VerdictEntry[] = [];
  const tallies = new Map<string, Tally>();
  const differences = new Map<
    string,
    { cases: number; maxDifference: number; differingPixels: number }
  >();
  if (run.projects.length === 0) a3.missingGroups.push('no browser project in the run');

  for (const dpr of A08_DPRS) {
    const cases = subset.filter((c) => c.dpr === dpr);
    if (cases.length === 0) continue;
    const keys = new Set(cases.map((c) => c.key));
    // Index each project's observations of this DPR, and check completeness (VZ4-A3).
    const byGroup = new Map<string, Map<string, Observation>>();
    for (const project of run.projects)
      for (const variant of VIZ_V4_VARIANTS) {
        const id = groupPath(project, variant, dpr);
        const group = groupOf.get(id);
        const index = new Map<string, Observation>();
        byGroup.set(id, index);
        if (group === undefined) {
          a3.missingGroups.push(id);
          continue;
        }
        if (group.meta['complete'] !== true) a3.incompleteGroups.push(id);
        for (const o of group.observations) {
          if (!keys.has(o.key)) a3.extraCases.push(`${id}:${o.key}`);
          else if (index.has(o.key)) a3.duplicateCases.push(`${id}:${o.key}`);
          else index.set(o.key, o);
          if (!STATUSES.includes(o.status)) a3.badStatuses.push(`${id}:${o.key}:${o.status}`);
        }
      }

    for (const c of cases) {
      const fringeRed = new Map<string, Uint8Array>();
      for (const variant of VIZ_V4_VARIANTS) {
        const want = expected.statuses[c.key]?.[variant];
        if (want === undefined)
          throw new Error(`viz-v4 metrics: no expected status for ${c.key} ${variant}`);
        const { samples } = variantQuery(variant);
        let node: NodeSide | null = null;
        let reference: Reference | null = null;
        for (const project of run.projects) {
          const id = groupPath(project, variant, dpr);
          const o = byGroup.get(id)!.get(c.key);
          const gated = c.gated && GATED_VARIANTS.includes(variant);
          let status: VizV4Status | null = o?.status ?? null;
          let reason = o?.reason ?? 'missing';
          let judgment: Judgment | null = null;
          let reasons: string[] = [];
          let metrics: CaseMetrics | null = null;
          let rule: RuleAccumulators | null = null;
          if (o === undefined) {
            if (byGroup.get(id)!.size > 0 || groupOf.has(id))
              a3.missingCases.push(`${id}:${c.key}`);
          } else {
            // VZ4-A5, the draw record: no exterior triangles in any msaa-4x draw, and a RENDERED
            // case has at least one draw of its node.
            if (variant === 'msaa-4x' && o.record !== null) {
              const draws = o.record.draws.filter((d) => d.nodeId === c.key);
              if (draws.some((d) => d.fringe !== 'region-only-off' || d.exteriorTriangles !== 0))
                a5Records.push(`${id}:${c.key}`);
              else if (o.status === 'RENDERED' && draws.length === 0)
                a5Records.push(`${id}:${c.key}:no draw of the case`);
            }
            if (variant === 'msaa-4x' && o.record === null && o.status === 'RENDERED')
              a5Records.push(`${id}:${c.key}:no draw record`);
            if (o.status === 'MESH-MISMATCH') a4.push(`${id}:${c.key}:headed`);
            if (o.status === 'RENDERED') {
              node ??= nodeSide(c, ports, variant);
              // VZ4-A4: the browser's port calls (requests and mesh digests) equal Node's.
              const browser = o.meshCalls.map(callKey).sort();
              if (browser.join('\n') !== node.calls.join('\n')) {
                a4.push(`${id}:${c.key}`);
                status = 'MESH-MISMATCH';
                reason = 'runner: browser port calls differ from Node';
              } else if (node.outcome.kind !== 'drawn') {
                judgment = 'UNDECIDED';
                reasons = [`node outcome ${node.outcome.kind}`];
              } else {
                reference ??= buildReference(node.outcome.draw, node.outcome.frame);
                const physical = physicalSize(dpr);
                const identity =
                  o.width === physical.width &&
                  o.height === physical.height &&
                  o.sampleCount === samples &&
                  o.devicePixelRatio === dpr &&
                  o.counts.samples === samples &&
                  reference.width === physical.width &&
                  reference.height === physical.height;
                if (!identity) {
                  judgment = 'FAIL';
                  reasons = ['capture identity'];
                } else {
                  const total = physical.width * physical.height;
                  const red = decodeRleBase64(o.red, total, 'u8');
                  const counts = decodeRleBase64(o.counts.rle, total * samples, 'u16');
                  const evaluated = evaluateCapture(
                    reference,
                    {
                      width: physical.width,
                      height: physical.height,
                      red,
                      counts,
                      samples: o.counts.samples,
                    },
                    samples,
                    { rule: true },
                  );
                  metrics = evaluated.metrics;
                  rule = evaluated.rule;
                  judgment = metrics.judgment;
                  reasons = [...metrics.reasons];
                  if (variant === 'msaa-4x' && metrics.a5.violations > 0)
                    a5Pixels.push(`${id}:${c.key}`);
                  // The 1x/4x difference (section 5.4), on the two fringe variants.
                  if (variant === 'fringe-1x') fringeRed.set(project, red);
                  if (variant === 'fringe-4x' && fringeRed.has(project)) {
                    const other = fringeRed.get(project)!;
                    let max = 0;
                    let differing = 0;
                    for (let i = 0; i < total; i += 1) {
                      const delta = Math.abs(other[i]! - red[i]!);
                      if (delta > 0) differing += 1;
                      if (delta > max) max = delta;
                    }
                    const dk = `${project}|${String(dpr)}|${c.part}`;
                    const d = differences.get(dk) ?? {
                      cases: 0,
                      maxDifference: 0,
                      differingPixels: 0,
                    };
                    d.cases += 1;
                    d.maxDifference = Math.max(d.maxDifference, max);
                    d.differingPixels += differing;
                    differences.set(dk, d);
                  }
                }
              }
            }
          }
          const entry: CaseEntry = {
            project,
            key: c.key,
            part: c.part,
            variant,
            dpr,
            gated,
            expected: want.status,
            headed: o?.status ?? null,
            status,
            reason,
            judgment,
            reasons,
            notGreyPixels: o?.notGreyPixels ?? null,
            metrics,
          };
          entries.push(entry);
          verdictEntries.push({
            project,
            key: c.key,
            variant,
            dpr,
            gated,
            expected: { status: want.status, reason: want.reason },
            headed: status,
            headedReason: reason,
            judgment,
            reasons,
          });
          const tk = `${project}|${variant}|${String(dpr)}|${c.part}`;
          const t = tallies.get(tk) ?? tally();
          add(t, entry, rule);
          tallies.set(tk, t);
        }
      }
    }
  }

  const verdict = decideVerdict(verdictEntries, run.projects);
  const a3Fail = Object.values(a3).some((list) => list.length > 0);
  const criteria: Record<string, Criterion> = {
    'VZ4-A3': { result: a3Fail ? 'FAIL' : 'PASS', ...a3 },
    'VZ4-A4': { result: a4.length > 0 ? 'FAIL' : 'PASS', mismatches: a4 },
    'VZ4-A5': {
      result: a5Records.length + a5Pixels.length > 0 ? 'FAIL' : 'PASS',
      recordFailures: a5Records,
      pixelFailures: a5Pixels,
    },
    'VZ4-A6': criterionFrom(entries, 'g12'),
    'VZ4-A7': criterionFrom(entries, 'g3'),
  };
  // A run that is incomplete, mismatched or not region-only in msaa-4x fails regardless of 5.3.
  const result: VerdictResult =
    criteria['VZ4-A3']!.result === 'FAIL' ||
    criteria['VZ4-A4']!.result === 'FAIL' ||
    criteria['VZ4-A5']!.result === 'FAIL'
      ? 'FAIL'
      : verdict.result;
  const groups = [...tallies.entries()].map(([k, t]) => {
    const [project, variant, dpr, part] = k.split('|') as [string, string, string, string];
    return { project, variant, dpr: Number(dpr), part, ...tallyJson(t) };
  });
  const difference1x4x = [...differences.entries()].map(([k, d]) => {
    const [project, dpr, part] = k.split('|') as [string, string, string];
    return { project, dpr: Number(dpr), part, ...d };
  });
  return {
    version: RECORD_VERSION,
    label: input.label,
    contract: CONTRACT,
    inputs: {
      subset: {
        version: summary.version,
        cases: summary.cases,
        keysSha256: summary.keysSha256,
        casesSha256: summary.casesSha256,
      },
      expected: { sha256: input.expectedSha256, version: expected.version },
      wasmSha256: input.wasmSha256,
      run: { projects: run.projects, files: run.files },
    },
    result,
    verdict,
    criteria,
    report: { groups, difference1x4x },
    cases: entries,
  };
}

// =============================================================================================
// Record files

/**
 * Where the inputs were and which Node evaluated them (review round 1 L4): binary64 report values
 * and BigInt formatting are reproducible only on the same engine, so a replay refuses another one.
 */
export type Provenance = Readonly<{
  runDir: string;
  wasm: string;
  expected: string;
  node: Readonly<{ version: string; v8: string }>;
}>;

/** record.json: the body, its SHA-256 and the provenance paths (no timestamp anywhere). */
export function recordText(body: RecordBody, provenance: Provenance): string {
  const serialized = canonicalJson(body);
  return `${canonicalJson({ body: JSON.parse(serialized) as unknown, bodySha256: sha256(serialized), provenance })}\n`;
}

export function recordMarkdown(body: RecordBody, bodySha256: string, provenance: Provenance) {
  const lines = [
    `# V-4 A08 metrics record (${body.label})`,
    '',
    `${body.label === DEFAULT_LABEL ? '**PRE-FREEZE, not counted.** A08 evidence counts only after C03-C05 (contract section 1.2). ' : ''}Contract: \`${body.contract}\`. Record \`${body.version}\`, body SHA-256 \`${bodySha256}\`.`,
    '',
    `- Result: **${body.result}** (section 5.3 verdict: ${body.verdict.result}${body.verdict.inconclusive.length > 0 ? `; ${body.verdict.inconclusive.join('; ')}` : ''})`,
    ...Object.entries(body.criteria).map(([id, c]) => `- ${id}: ${c.result}`),
    `- Browsers: ${(body.inputs['run'] as { projects: string[] }).projects.join(', ') || 'none'}`,
    `- Failing gated cases: ${String(body.verdict.failing.length)}; undecided: ${String(body.verdict.undecided.length)}; deviations from the expected list: ${String(body.verdict.deviations.length)}; flagged RENDERER-FAILED or port-empty: ${String(body.verdict.flagged.length)}`,
    `- Run: \`${provenance.runDir}\`; WASM \`${provenance.wasm}\` (\`${String(body.inputs['wasmSha256'])}\`); expected list \`${provenance.expected}\``,
    '',
  ];
  if (body.verdict.failing.length > 0) {
    lines.push('## Failing gated cases', '');
    for (const f of body.verdict.failing.slice(0, MD_LIMIT))
      lines.push(`- ${f.project} ${f.variant} \`${f.key}\`: ${f.gates.join(', ')}`);
    if (body.verdict.failing.length > MD_LIMIT)
      lines.push(`- ... ${String(body.verdict.failing.length - MD_LIMIT)} more in record.json`);
    lines.push('');
  }
  lines.push(
    '## Replay',
    '',
    '`pnpm coverage:viz-v4 --replay <this directory>` re-evaluates the inputs and requires a byte-identical record.json (VZ4-A9).',
    '',
  );
  return `${lines.join('\n')}`;
}

export function writeRecord(outDir: string, body: RecordBody, provenance: Provenance): string {
  mkdirSync(outDir, { recursive: true });
  const text = recordText(body, provenance);
  const parsed = JSON.parse(text) as { bodySha256: string };
  writeFileSync(path.join(outDir, 'record.json'), text);
  writeFileSync(
    path.join(outDir, 'record.md'),
    recordMarkdown(body, parsed.bodySha256, provenance),
  );
  return text;
}

// =============================================================================================
// Entry points (freeze-guarded)

export type RunnerOptions = Readonly<{
  root: string;
  runDir: string;
  wasmPath: string;
  expectedPath: string;
  subset: readonly A08Case[];
  /** Builds the fill and stroke ports from the WASM bytes. */
  loadPorts: (bytes: Uint8Array) => Promise<Ports>;
  label?: string;
  /** The E3 freeze check; `a04FreezeRecorded` by default. */
  freezeRecorded?: (root: string) => boolean;
}>;

function guard(options: RunnerOptions): void {
  const recorded = (options.freezeRecorded ?? a04FreezeRecorded)(options.root);
  if (!recorded)
    throw new Error(
      'refusing the A08 metrics run: the E3 contract has no freeze record for a04-corpus/v1 (E3 section 5.5)',
    );
}

function relative(root: string, file: string): string {
  return path.relative(root, file).split(path.sep).join('/');
}

async function evaluateFromFiles(options: RunnerOptions, label: string) {
  const bytes = new Uint8Array(readFileSync(options.wasmPath));
  const expectedBytes = readFileSync(options.expectedPath);
  const body = evaluateRun({
    run: loadRun(options.runDir),
    expected: JSON.parse(expectedBytes.toString('utf8')) as ExpectedFile,
    expectedSha256: sha256(expectedBytes),
    subset: options.subset,
    ports: await options.loadPorts(bytes),
    wasmSha256: sha256(bytes),
    label,
  });
  const provenance: Provenance = {
    runDir: relative(options.root, options.runDir),
    wasm: relative(options.root, options.wasmPath),
    expected: relative(options.root, options.expectedPath),
    node: { version: process.version, v8: process.versions.v8 },
  };
  return { body, provenance };
}

/** `pnpm coverage:viz-v4 --run <dir>`: evaluates a run and writes record.json and record.md. */
export async function runMetrics(
  options: RunnerOptions & Readonly<{ outDir: string }>,
): Promise<Readonly<{ body: RecordBody; text: string }>> {
  guard(options);
  const { body, provenance } = await evaluateFromFiles(options, options.label ?? DEFAULT_LABEL);
  const text = writeRecord(options.outDir, body, provenance);
  return { body, text };
}

/**
 * `pnpm coverage:viz-v4 --replay <record dir>` (VZ4-A9): re-evaluates the record's inputs, by its
 * provenance paths unless overridden, and returns whether record.json is reproduced byte for byte.
 */
export async function replayRecord(
  options: Omit<RunnerOptions, 'runDir' | 'wasmPath' | 'expectedPath' | 'label'> &
    Readonly<{ recordDir: string; runDir?: string; wasmPath?: string; expectedPath?: string }>,
): Promise<Readonly<{ identical: boolean; reason: string | null; text: string }>> {
  const stored = readFileSync(path.join(options.recordDir, 'record.json'), 'utf8');
  const record = JSON.parse(stored) as { body: RecordBody; provenance: Provenance };
  const full: RunnerOptions = {
    ...options,
    runDir: options.runDir ?? path.resolve(options.root, record.provenance.runDir),
    wasmPath: options.wasmPath ?? path.resolve(options.root, record.provenance.wasm),
    expectedPath: options.expectedPath ?? path.resolve(options.root, record.provenance.expected),
    label: record.body.label,
  };
  guard(full);
  const node = record.provenance.node;
  if (node?.version !== process.version || node.v8 !== process.versions.v8)
    throw new Error(
      `refusing the VZ4-A9 replay: the record was evaluated on Node ${String(node?.version)} (V8 ${String(node?.v8)}), this is Node ${process.version} (V8 ${process.versions.v8})`,
    );
  const storedFiles = (record.body.inputs['run'] as { files: Record<string, string> }).files;
  const current = loadRun(full.runDir).files;
  if (canonicalJson(storedFiles) !== canonicalJson(current))
    return { identical: false, reason: 'the run files differ from the record inputs', text: '' };
  const { body } = await evaluateFromFiles(full, record.body.label);
  const text = recordText(body, record.provenance);
  if (text === stored) return { identical: true, reason: null, text };
  let at = 0;
  while (at < text.length && text[at] === stored[at]) at += 1;
  return { identical: false, reason: `record.json differs from byte ${String(at)}`, text };
}
