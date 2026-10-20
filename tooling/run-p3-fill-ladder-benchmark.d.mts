import type {
  analyzeRatioNative,
  ratioModeConfig,
  RatioOutput,
} from '../tests/geometry/p3-fill-ladder/analysis.js';

export function parseArguments(args: readonly string[]): {
  profile: 'functional' | 'reference';
  environmentJson: string | null;
};
export function sourceManifest(): Record<string, string>;
export function main(args?: readonly string[]): Promise<string>;
export function runRatioMode(options: {
  profile: 'functional' | 'reference';
  output: string;
}): Promise<{
  config: ReturnType<typeof ratioModeConfig>;
  configHash: string;
  toolchain: { release: string; commit: string; host: string; verbose: string };
  build: { command: string; targetDirectory: string; rustflags: readonly string[] };
  corpus: { sha256: string; bytes: number };
  repetitions: readonly RatioOutput[];
  failures: readonly { stage: string; error: string; log: string }[];
  analysis: ReturnType<typeof analyzeRatioNative>;
}>;
