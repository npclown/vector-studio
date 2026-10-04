export type Mode = 'SMOKE' | 'FULL';
export function parseArguments(args: readonly string[]): {
  mode: Mode;
  nativeDirectory: string | null;
  requested: string | null;
};
export function resolveOutputTarget(requested: string): string;
export function reserveOutput(
  mode: Mode,
  requested: string | null,
  nativeDirectory?: string | null,
): string;
export function resolveNativeDirectory(requested: string): string;
export function assertFullSource(): void;
export function validateNodeVersion(version: string | undefined): void;
export function workerOutcome(
  result: { status: number | null; signal?: string | null; error?: Error | null },
  label: string,
): void;
export function main(args?: readonly string[]): Promise<string>;
