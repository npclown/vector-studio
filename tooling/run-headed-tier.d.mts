export declare const NEXT_HOST_SUITES: readonly string[];
export declare function parse(argv: readonly string[]): {
  tier: 2 | 3;
  workers: string;
  extra: string[];
};
export declare function stages(tier: number): { name: string; script: string }[];
export declare function stageArgs(stage: { script: string }, extra: readonly string[]): string[];
