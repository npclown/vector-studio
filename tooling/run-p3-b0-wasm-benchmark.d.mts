export function parseArguments(args: readonly string[]): {
  profile: 'functional' | 'reference';
  environmentJson: string | null;
};
export function sourceManifest(): Record<string, string>;
/** The one committed AL-S1 reference record, or null when none is committed. */
export function findAlS1Record(): { file: string; bytes: Uint8Array } | null;
export function main(args?: readonly string[]): Promise<string>;
