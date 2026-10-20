export function parseArguments(args: readonly string[]): {
  profile: 'functional' | 'reference';
  environmentJson: string | null;
  alS1: string | null;
};
export function sourceManifest(): Record<string, string>;
/** The AL-S1 reference record to link: `explicit`, or the only one of this kernel; or null. */
export function findAlS1Record(options?: {
  explicit?: string | null;
  kernelSha256?: string | null;
}): { file: string; bytes: Uint8Array } | null;
export function main(args?: readonly string[]): Promise<string>;
