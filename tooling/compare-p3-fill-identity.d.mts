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
