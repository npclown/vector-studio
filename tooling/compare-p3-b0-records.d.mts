export interface IdentityDifference {
  field: string;
  old: string;
  new: string;
}
export interface IdentityResult {
  pass: boolean;
  differences: IdentityDifference[];
}
export interface Pair {
  old: number | null;
  new: number | null;
  ratio: number | null;
}
export interface ComparisonReport {
  verdict: { old: string; new: string };
  checks: { old: string[]; new: string[] };
  cells: {
    cell: string;
    series: string;
    leaves: number;
    batchMedianNs: Pair;
    pathMedianNs: Pair;
  }[];
  fits: {
    series: string;
    kind: string;
    repetition: number;
    slope: Pair;
    estimateNs: Pair;
  }[];
  estimates: { perPathNs: Pair; initialMs: Pair; editMs: Pair; meshBytes: Pair };
  stages: {
    series: string;
    oldCell: string | null;
    newCell: string | null;
    flatten: Pair;
    topology: Pair;
    tessellation: Pair;
    total: Pair;
    exactShare: Pair;
    overhead: Pair;
    h1Verdict: { old: string; new: string | null };
  }[];
  h1Caveat: string;
}
/** A parsed P3 B0 result record; typed loosely because analysis.ts owns the schema. */
export type B0RecordJson = object;
export const PINNED_CONFIG_HASH: string;
export const PINNED_CORPUS_SHA256: string;
export function parseArguments(args: readonly string[]): {
  old: string;
  new: string;
  markdown: string | null;
};
export function loadRecord(file: string): B0RecordJson;
export function identityCheck(oldRecord: B0RecordJson, newRecord: B0RecordJson): IdentityResult;
export function compareRecords(oldRecord: B0RecordJson, newRecord: B0RecordJson): ComparisonReport;
export function renderMarkdown(
  report: ComparisonReport,
  identity: IdentityResult,
  names?: { old: string; new: string },
): string;
export function main(args?: readonly string[]): Promise<boolean>;
