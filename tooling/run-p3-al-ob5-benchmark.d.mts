export function parseArguments(args: readonly string[]): {
  profile: 'functional' | 'reference';
  environmentJson: string | null;
};
/** B0's environment observations plus the optional quiet-machine statement. */
export function readObservations(file: string): {
  observedAt: string;
  power: { value: string; source: string };
  backgroundLoad: { value: string; source: string };
  quietMachine: { value: string; source: string } | null;
};
export function sourceManifest(): Record<string, string>;
/** OB5-V13: every file's blob at `commit` against the file on disk. */
export function commitCheck(
  commit: string,
  files: readonly string[],
): { commit: string; checked: number; mismatches: string[] };
export function main(args?: readonly string[]): Promise<string>;
