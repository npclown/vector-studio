export declare const DEFAULT_WORKERS: string;
export declare function resolveWorkers(
  workers: string | null,
  env: Readonly<Record<string, string | undefined>>,
): string;
export declare function missingPrerequisite(
  gpuOnly: boolean,
  env: Readonly<Record<string, string | undefined>>,
): string | null;
export declare const NEXT_HOST_SUITES: readonly string[];
export declare function parse(argv: readonly string[]): {
  tier: 2 | 3;
  workers: string | null;
  gpuOnly: boolean;
  extra: string[];
};
export declare function stages(
  tier: number,
  gpuOnly?: boolean,
): { name: string; script: string; env?: Record<string, string> }[];
export declare function stageArgs(stage: { script: string }, extra: readonly string[]): string[];
