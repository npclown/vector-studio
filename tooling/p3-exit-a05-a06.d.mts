export type Criterion = 'A03' | 'A05' | 'A06';
export const MAP_CRITERIA: Record<string, Criterion[]>;
export interface MapEntry {
  id: string;
  source: string;
  kind: 'required' | 'supplementary' | 'headed';
  runner: 'cargo' | 'unit' | 'geometry' | 'headed';
  filter?: string;
  file?: string;
  each?: string[];
}
export interface EvidenceMap {
  version: string;
  contract: string;
  note?: string;
  criteria: Partial<Record<Criterion, MapEntry[]>>;
}
export interface TestResult {
  name?: string;
  file?: string;
  title?: string;
  fullName?: string;
  status: string;
}
export interface RunnerResult {
  ok: boolean;
  tests: TestResult[];
}
export interface Row {
  criterion: Criterion;
  entry: MapEntry;
  verdict: 'PASS' | 'FAIL' | 'HEADED';
  selected: number;
  failures: string[];
}
export interface Evaluation {
  rows: Row[];
  criteria: Partial<Record<Criterion, string>>;
}
export function checkMap(
  map: EvidenceMap,
  io: { exists: (path: string) => boolean; read: (path: string) => string },
): string[];
export function parseCargoTests(stdout: string): { name: string; status: string }[];
export function vitestTests(
  report: {
    testResults: {
      name: string;
      assertionResults: { title: string; fullName: string; status: string }[];
    }[];
  },
  root: string,
): TestResult[];
export function evaluate(
  map: EvidenceMap,
  results: Partial<Record<string, RunnerResult>>,
): Evaluation;
export function renderMarkdown(
  evaluation: Evaluation,
  provenance: { label: string; identities: Record<string, string> },
): string;
export function findSnapshotRecord(
  contract: string,
  label: string,
): { block: string; error?: undefined } | { error: string; block?: undefined };
export function identityMismatches(block: string, identities: Record<string, string>): string[];
