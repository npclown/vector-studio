export interface DigestEntry {
  digest: string;
  allocations: number;
  code: string;
  crossings: number;
}
export interface DigestComparison {
  missing: string[];
  extra: string[];
  differing: string[];
  equal: boolean;
}
export interface CoverageCounts {
  paths: number;
  ok: number;
  knotMismatch: number;
  unresolved: number;
  capFailure: number;
  okWithCrossings: number;
}
export const B0_CORPUS_SHA256: string;
export const WASM_RANDOM_PATHS: number;
export function inlineTestModules(source: string): Map<string, string>;
export function compareInlineTestModules(
  file: string,
  baseSource: string,
  branchSource: string,
): string[];
export function parseNativeDigests(text: string): Map<string, DigestEntry>;
export function compareDigests(
  base: Map<string, DigestEntry>,
  branch: Map<string, DigestEntry>,
): DigestComparison;
export function tamper(cases: Map<string, DigestEntry>, name: string): Map<string, DigestEntry>;
export function isCapFailure(code: string): boolean;
export function randomCoverage(cases: Map<string, DigestEntry>): {
  counts: CoverageCounts;
  perEntry: Record<string, Record<string, number>>;
};
export function missedFloors(
  counts: CoverageCounts,
  floors: Readonly<Record<string, number>>,
): string[];
export function packFillInput(
  verbs: readonly number[],
  points: readonly number[],
  rule: number,
  exponent: number,
  requestId: number,
): Uint8Array;
export function main(args?: readonly string[]): Promise<boolean>;
export const RANDOM_CORPUS_SHA256: string;
export const WASM_STRATUM_PATHS: number;
export interface WasmSelection {
  family: string;
  index: number;
  path: { rule: number; exponent: number; verbs: readonly number[]; points: readonly number[] };
  reason: 'first' | 'crossing' | 'exponent' | 'scaled' | 'stride';
}
export function selectWasmRandomPaths(
  corpus: readonly {
    family: { id: string };
    paths: readonly WasmSelection['path'][];
  }[],
  crossingPaths: ReadonlySet<string>,
  defaultExponent?: number,
): WasmSelection[];
export function nativeCascadeName(wasmName: string): string;
export function compareWasmToNative(
  wasm: Map<string, DigestEntry>,
  native: Map<string, DigestEntry>,
): DigestComparison;
export const LADDER_CORPUS_SHA256: string;
export interface IdentityOptions {
  base: string | null;
  threads: number | null;
  compareOnly: string | null;
  tamper: string | null;
  allowTestChanges: string[];
  revisionChange: boolean;
  /** Present (true) only when --failure-to-success was given. */
  failureToSuccess?: boolean;
  selfTest: boolean;
}
export function parseArguments(args: readonly string[]): IdentityOptions;
export function checkTestFileChanges(
  listing: readonly string[],
  allowList: readonly string[],
): { allowed: string[]; failures: string[] };
export function checkRevisions(base: number, branch: number, revisionChange: boolean): string[];
export interface RungRecord {
  rung: 0 | 1;
  reason: string;
  step: string;
  exact: string;
}
export function parseRungRecord(text: string): Map<string, RungRecord>;
export function rungPathOf(name: string): string | null;
export function familyOf(path: string): string;
export type RevisionClass = 'unchanged' | 'fast-identical' | 'changed-fast' | 'newly-admitted';
export interface ClassifiedCase {
  case: string;
  layer: 'native' | 'wasm';
  path: string;
  family: string;
  class: RevisionClass;
  oldStatus: string;
  reason: string;
}
export interface RevisionChangeInput {
  native: { base: Map<string, DigestEntry>; branch: Map<string, DigestEntry> };
  wasm: { base: Map<string, DigestEntry>; branch: Map<string, DigestEntry> };
  rungs: Map<string, RungRecord>;
}
export function classifyRevisionChange(input: RevisionChangeInput): {
  cases: ClassifiedCase[];
  failures: string[];
  metaDiffering: string[];
};
export function changedPaths(cases: readonly ClassifiedCase[]): string[];
export function applyOracleValidation(
  cases: readonly ClassifiedCase[],
  validation: ReadonlyMap<string, { rung: string; failures: readonly string[] }>,
): string[];
export function revisionManifest(cases: readonly ClassifiedCase[]): {
  text: string;
  sha256: string;
  counts: Record<string, Record<RevisionClass, number>>;
};
export function revisionSelfCheck(
  input: RevisionChangeInput,
  name: string,
): { case: string; detected: boolean };
export function revisionTamperChecks(
  input: RevisionChangeInput,
): { case: string | null; detected: boolean }[];
export const FILL_ENGINE_META: string;
export interface PathSource {
  rule: 0 | 1;
  exponent: number;
  verbs: readonly number[];
  points: readonly number[];
}
export function pathSources(
  b0: unknown,
  random: unknown,
  ladderPaths: readonly PathSource[],
): Map<string, PathSource>;
export function validateChangedPaths(
  paths: readonly string[],
  sources: ReadonlyMap<string, PathSource>,
  directory: string,
  revision: number,
): Promise<Map<string, { rung: string; failures: string[] }>>;
export type OutcomeClass = 'ok' | 'path-failure' | 'internal' | 'batch' | 'other';
export function classifyOutcome(code: string): OutcomeClass;
export function differingFields(base: DigestEntry, branch: DigestEntry): string[];
export interface FailureToSuccessCounts {
  identical: number;
  allowedChange: number;
  fail: number;
  internalRegression: number;
}
export interface FailureToSuccessInput {
  native: { base: Map<string, DigestEntry>; branch: Map<string, DigestEntry> };
  wasm: { base: Map<string, DigestEntry>; branch: Map<string, DigestEntry> };
}
export function classifyFailureToSuccess(input: FailureToSuccessInput): {
  counts: FailureToSuccessCounts;
  perLayer: { native: FailureToSuccessCounts; wasm: FailureToSuccessCounts };
  allowed: { layer: string; case: string; baseCode: string; branchCode: string }[];
  fails: { layer: string; case: string; reason: string }[];
  internalRegressions: { layer: string; case: string; reason: string }[];
  failures: string[];
  pass: boolean;
};
export function failureToSuccessTamperChecks(
  input: FailureToSuccessInput,
): { case: string | null; detected: boolean }[];
