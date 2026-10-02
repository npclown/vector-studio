export const SCHEMA: 'p3-cubic-readiness-census/v1';
export const FAILURE_STAGES: readonly [
  'CLI',
  'TOOLCHAIN',
  'SOURCE',
  'INPUT',
  'NATIVE',
  'OUTPUT',
  'ABI',
  'BOUND',
  'PROOF',
  'JOURNAL',
  'WORKER',
  'SUMMARY',
  'AUDIT',
];
export type CensusFailureStage = (typeof FAILURE_STAGES)[number];
export function sha256(bytes: ArrayBufferView | string): string;
export function captureSource(root: string): Readonly<{
  head: string;
  dirty: boolean;
  entries: readonly Readonly<{ path: string; sha256: string }>[];
  sha256: string;
}>;
export function policy(mode: 'SMOKE' | 'FULL'): Record<string, unknown>;
export function writeJsonExclusive(file: string, value: unknown): void;
export function createInvocation(
  root: string,
  outputDirectory: string,
  mode: 'SMOKE' | 'FULL',
  rust: Record<string, string>,
): Record<string, unknown>;
export function describeJournal(outputDirectory: string): Record<string, unknown>;
export function appendJournalRow(outputDirectory: string, row: unknown): void;
export function readJournalRows(outputDirectory: string): unknown[];
export function finishMetadata(
  root: string,
  invocation: Readonly<{ metadata: unknown }>,
): Record<string, unknown>;
export function writeIncomplete(
  root: string,
  outputDirectory: string,
  stage: CensusFailureStage,
  message: string,
  index?: number | null,
): void;
export function readExact(fd: number, length: number): Uint8Array<ArrayBuffer>;
