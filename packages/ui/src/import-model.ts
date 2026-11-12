import type { SvgFileImport } from '@vector-studio/react';

// V-33 SVG import contract (docs/plans/viz-v33-svg-import-contract.md), V33-U1: the Import
// panel's status lines, from the outcome of each imported file.

/**
 * The status lines of an import: `Imported <name>` (one file) or `Imported <n> files`, then
 * `Skipped: <names>` when the converter dropped something, then `Failed: <name> (<code>)` per
 * failed file, or `Import failed: <code>` when the only file failed. Empty for no SVG file.
 */
export function importMessages(outcomes: readonly SvgFileImport[]): string[] {
  if (outcomes.length === 0) return ['No SVG file'];
  const done = outcomes.filter((entry) => entry.result.ok);
  const failed = outcomes.filter((entry) => !entry.result.ok);
  if (outcomes.length === 1 && failed.length === 1) {
    const result = failed[0]!.result;
    return [`Import failed: ${result.ok ? '' : result.code}`];
  }
  const lines: string[] = [];
  if (done.length === 1) lines.push(`Imported ${done[0]!.name}`);
  else if (done.length > 1) lines.push(`Imported ${done.length} files`);
  const skipped = [...new Set(done.flatMap((entry) => entry.skipped))];
  if (skipped.length > 0) lines.push(`Skipped: ${skipped.join(', ')}`);
  for (const entry of failed) {
    if (!entry.result.ok) lines.push(`Failed: ${entry.name} (${entry.result.code})`);
  }
  return lines;
}
