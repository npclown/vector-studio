export function parseArguments(args: readonly string[]): {
  profile: 'functional' | 'reference';
  environmentJson: string | null;
};
export function readEnvironmentObservations(file: string): {
  observedAt: string;
  power: { value: string; source: string };
  backgroundLoad: { value: string; source: string };
};
export function sourceManifest(): Record<string, string>;
export function main(args?: readonly string[]): Promise<string>;
