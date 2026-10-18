export function parseArguments(args: readonly string[]): {
  profile: 'functional' | 'reference';
  environmentJson: string | null;
};
export function sourceManifest(): Record<string, string>;
export function main(args?: readonly string[]): Promise<string>;
