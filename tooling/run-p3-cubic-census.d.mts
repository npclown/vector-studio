export type Mode = 'SMOKE' | 'FULL';
export function parseArguments(args: readonly string[]): { mode: Mode; requested: string | null };
export function reserveOutput(mode: Mode, requested: string | null): string;
export function assertToolchainPresent(file: string): void;
export function validateToolchainIdentity(identity: {
  nodeVersion: string | undefined;
  release: string | undefined;
  commit: string | undefined;
  host: string | undefined;
}): { release: string; commit: string; host: string };
export function workerOutcome(
  result: {
    status: number | null;
    signal?: string | null;
    error?: Error | null;
  },
  label: string,
): void;
export function main(args?: readonly string[]): Promise<string>;
